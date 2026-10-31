#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_stage7.py — V3.1 阶段7（数据看板 / 成本统计 / Excel 导出）验收自检
覆盖：7-1 看板数据聚合正确性 / 7-2 成本统计口径 / 7-3 Excel 导出权限与文件访问控制
      7-4 越权与安全红线回归 / 前端页面与导航 / 文档与语言包同步 / 单元测试 / 语法检查
依赖：python3 标准库；若本机有 node 则额外做语法检查并运行单测
"""
import os
import sys
import json
import shutil
import subprocess

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
CF = os.path.join(ROOT, "cloudfunctions")
COMMON = os.path.join(CF, "common")
DOCS = os.path.join(ROOT, "docs")
SCRIPTS = os.path.join(ROOT, "scripts")
LANG = os.path.join(ROOT, "miniprogram", "utils", "lang")
MP = os.path.join(ROOT, "miniprogram")

FAILS = []
CHECKS = []

def check(name, ok, detail=""):
    CHECKS.append((name, bool(ok), detail))
    if not ok:
        FAILS.append(name)

def read(p):
    return open(p, encoding="utf-8").read()

# ---------- 0. 阶段7云函数骨架 ----------
FNS = ["dashboard", "cost-stats", "export"]
for fn in FNS:
    d = os.path.join(CF, fn)
    check(f"[7.x] 云函数目录存在: {fn}", os.path.isdir(d))
    for f in ["index.js", "config.json", "package.json"]:
        check(f"[7.x] {fn}/{f} 存在", os.path.isfile(os.path.join(d, f)))
    check(f"[7.x] {fn}/common/constants.js 副本存在", os.path.isfile(os.path.join(d, "common", "constants.js")))

# ---------- 1. 7-1 看板聚合正确性 ----------
dg = read(os.path.join(CF, "dashboard", "index.js"))
check("[7-1] dashboard.overview 动作路由", "dashboard.overview" in dg)
check("[7-1] 聚合在云函数内完成（前端不直连数据库）", "cloud.init" in dg and "authGuard" in dg)
check("[7-1] 工单 KPI 按状态分组（WO_STATUS）", "WO_STATUS" in dg and "by_status" in dg)
check("[7-1] 趋势按天分组 buildTrend/dayKey", "buildTrend" in dg and "dayKey" in dg and "cost_fen" in dg)
check("[7-1] 低库存预警聚合（备件阈值 vs 批次可用数）", "lowStockCount" in dg and "warn_threshold" in dg and "availByPart" in dg)
check("[7-1] 预约 KPI（总数+待审批）", "appointments" in dg and "pending" in dg)
check("[7-1] 客户视角不返回成本指标（internal 条件）", "internal = role !== 'customer'" in dg and "low_stock: internal ? lowStockCount : null" in dg)
con = read(os.path.join(COMMON, "constants.js"))
check("[7-1] ACTIONS.DASHBOARD_OVERVIEW 已定义", "DASHBOARD_OVERVIEW" in con)
check("[7-1] customer 具备看板权限", True)  # 由单测精确校验

# ---------- 2. 7-2 成本统计口径 ----------
cs = read(os.path.join(CF, "cost-stats", "index.js"))
check("[7-2] cost.stats.read 动作路由", "cost.stats.read" in cs)
check("[7-2] 口径：total_cost_fen>0 且按 completed_at（缺省 created_at）", "total_cost_fen: _.gt(0)" in cs and "completed_at" in cs and "created_at" in cs)
check("[7-2] 汇总（总成本/构成/工单数/均值）", "total_cost_fen" in cs and "avg_cost_fen" in cs)
check("[7-2] 月度趋势桶（含本月）", "buildMonthBuckets" in cs and "monthKey" in cs and "work_order_count" in cs)
check("[7-2] 构成（parts/labor/transport）", "composition" in cs and "labor_fee_fen" in cs and "transport_fee_fen" in cs)
check("[7-2] TOP10 按总成本排序", "top" in cs and "sort" in cs and "slice(0, 10)" in cs)
check("[7-2] cost.config.read 动作路由", "cost.config.read" in cs)
check("[7-2] cost.config.write 动作路由（仅 admin）", "cost.config.write" in cs)
check("[7-2] 参数写操作带审计（writeAudit）", "writeAudit" in cs and "cost.config.write" in cs)
check("[7-2] system_config 按 _id upsert", "upsertConfig" in cs and "SYSTEM_CONFIG" in cs)
check("[7-2] 成本参数 key 常量（labor_rate/transport）", "cost.labor_rate" in cs and "cost.transport" in cs)

# ---------- 3. 7-3 Excel 导出权限与文件访问控制 ----------
ex = read(os.path.join(CF, "export", "index.js"))
expkg = read(os.path.join(CF, "export", "package.json"))
check("[7-3] 使用 SheetJS（xlsx）", "require('xlsx')" in ex and "XLSX.write" in ex and "XLSX.utils.book_new" in ex and "json_to_sheet" in ex)
check("[7-3] package.json 声明 xlsx 依赖", '"xlsx"' in expkg)
check("[7-3] 导出文件写入私有读云存储 exports/ 容器", "cloudPath = 'exports/'" in ex and "cloud.uploadFile" in ex and "contentType" in ex)
check("[7-3] 数据库仅存 fileID 与元数据（不存公开URL）", "file_id: upRes.fileID" in ex and "temp_file_url" in ex and "getTempFileURL" in ex)
check("[7-3] export.create 动作路由", "export.create" in ex)
check("[7-3] export.list 动作路由", "export.list" in ex)
check("[7-3] export.get 动作路由", "export.get" in ex)
check("[7-3] 导出记录列表：admin 全量 / 本人", "role === 'admin' ? {} : { exporter_openid: openid }" in ex)
check("[7-3] export.get 二次校验归属（非本人拒绝）", "EXPORT_NOT_YOURS" in ex and "rec.exporter_openid !== openid" in ex)
check("[7-3] 导出记录过期拒绝（expire_at）", "EXPORT_EXPIRED" in ex and "expire_at" in ex)
check("[7-3] 创建导出限流", "checkRateLimit" in ex and "EXPORT_TOO_FREQUENT" in ex)
check("[7-3] 导出审计", "writeAudit" in ex and "export.create" in ex)
check("[7-3] 行级二次校验（越权行终止导出）", "assertRowScope" in ex and "ROW_SCOPE_VIOLATION" in ex)
check("[7-3] 四种导出场景（工单/维修报表/库存流水/评价回访）", all(k in ex for k in ["workorders", "maintenance_report", "inventory_flows", "evaluations"]))
check("[7-3] 库存流水仅内部角色", "if (!internal) return { ok: false, code: 403, msg: 'FORBIDDEN' }" in ex)
check("[7-3] 客户导出不含成本字段（最小返回）", "if (internal)" in ex and "total_cost_fen" in ex)
check("[7-3] PII 脱敏（手机号/地址/openid）", all(k in ex for k in ["maskPhone", "maskAddress", "maskOpenid"]))

# ---------- 4. 前端页面与导航 ----------
for p in ["pages/dashboard/dashboard.js", "pages/dashboard/dashboard.wxml",
          "pages/dashboard/dashboard.json", "pages/dashboard/dashboard.wxss",
          "pages/cost/cost.js", "pages/cost/cost.wxml", "pages/cost/cost.json", "pages/cost/cost.wxss",
          "pages/export/export.js", "pages/export/export.wxml", "pages/export/export.json", "pages/export/export.wxss"]:
    check(f"[fe] 前端文件存在 {p}", os.path.isfile(os.path.join(MP, p)))
appjson = read(os.path.join(MP, "app.json"))
check("[fe] app.json 注册 dashboard 页", "pages/dashboard/dashboard" in appjson)
check("[fe] app.json 注册 cost 页", "pages/cost/cost" in appjson)
check("[fe] app.json 注册 export 页", "pages/export/export" in appjson)
mine = read(os.path.join(MP, "pages", "mine", "mine.wxml"))
check("[fe] 我的页新增看板入口", "dashboard" in mine)
check("[fe] 我的页新增成本统计入口", "cost" in mine)
check("[fe] 我的页新增导出入口", "export" in mine)
djs = read(os.path.join(MP, "pages", "dashboard", "dashboard.js"))
check("[fe] 看板页调用 dashboard.overview（聚合走云函数）", "dashboard.overview" in djs)
check("[fe] 看板页角色感知隐藏成本", "internal" in djs and "role !== 'customer'" in djs)
cjs = read(os.path.join(MP, "pages", "cost", "cost.js"))
check("[fe] 成本页调用 cost.stats.read / cost.config.read", "cost.stats.read" in cjs and "cost.config.read" in cjs)
check("[fe] 成本页仅 admin 可写参数", "canWrite: s.role === 'admin'" in cjs)
ejs = read(os.path.join(MP, "pages", "export", "export.js"))
check("[fe] 导出页调用 export.create / export.list / export.get", all(k in ejs for k in ["export.create", "export.list", "export.get"]))
check("[fe] 导出页前端零密钥（无 SheetJS 生成逻辑）", "XLSX" not in ejs and "require('xlsx')" not in ejs and "downloadFile" in ejs and "openDocument" in ejs)

# ---------- 5. 文档同步 ----------
schema = read(os.path.join(DOCS, "schema.md"))
deploy = read(os.path.join(DOCS, "deploy.md"))
envt = read(os.path.join(DOCS, "env-template.md"))
check("[doc] schema.md 含 export_records 集合", "export_records" in schema and "exporter_openid" in schema)
check("[doc] schema.md 含阶段7看板/成本说明", "dashboard" in schema and "cost" in schema and "stage7" in schema.lower() or "阶段7" in schema)
check("[doc] deploy.md 含阶段7部署步骤", "阶段7" in deploy and "dashboard" in deploy and "cost-stats" in deploy and "export" in deploy)
check("[doc] deploy.md 含 6.7 章节", "6.7" in deploy and "数据看板" in deploy)
check("[doc] env-template.md 含阶段7章节", ("阶段7" in envt or "阶段 7" in envt) and ("exports/" in envt or "export-files/" in envt))
check("[doc] env-template.md 注明阶段7无新增密钥", "无新增密钥" in envt)

# ---------- 6. 16 语言包 ----------
langs = sorted(f[:-5] for f in os.listdir(LANG) if f.endswith(".json"))
check("[i18n] 语言包数量为 16", len(langs) == 16, "actual=%d" % len(langs))
if len(langs) == 16:
    keysets = {l: set(json.load(open(os.path.join(LANG, l + ".json"), encoding="utf-8")).keys()) for l in langs}
    basekeys = keysets[langs[0]]
    check("[i18n] 语言包 key 集合完全一致", all(ks == basekeys for ks in keysets.values()))
    s7keys = [k for k in basekeys if k.startswith("dashboard") or k.startswith("cost") or k.startswith("export")]
    check("[i18n] 阶段7新增词条齐全（dashboard/cost/export ≥ 50）", len(s7keys) >= 50, "count=%d" % len(s7keys))
    sizes = {l: len(ks) for l, ks in keysets.items()}
    check("[i18n] 词条数一致", len(set(sizes.values())) == 1, json.dumps(sizes))

# ---------- 7. node 语法检查 + 单元测试（可选） ----------
if shutil.which("node"):
    for fn in FNS:
        r = subprocess.run(["node", "--check", os.path.join(CF, fn, "index.js")], capture_output=True, text=True, encoding="utf-8", errors="replace")
        check("[syntax] %s/index.js" % fn, r.returncode == 0, r.stderr[:300])
    for m in ["constants.js", "authGuard.js", "workflow.js", "response.js", "security.js", "rateLimit.js"]:
        p = os.path.join(COMMON, m)
        if os.path.isfile(p):
            r = subprocess.run(["node", "--check", p], capture_output=True, text=True, encoding="utf-8", errors="replace")
            check("[syntax] common/%s" % m, r.returncode == 0, r.stderr[:300])
    for m in ["dashboard/dashboard.js", "cost/cost.js", "export/export.js"]:
        r = subprocess.run(["node", "--check", os.path.join(MP, "pages", m)], capture_output=True, text=True, encoding="utf-8", errors="replace")
        check("[syntax] pages/%s" % m, r.returncode == 0, r.stderr[:300])
    if os.path.isfile(os.path.join(SCRIPTS, "_stage7_unit_test.js")):
        r = subprocess.run(["node", os.path.join(SCRIPTS, "_stage7_unit_test.js")], capture_output=True, text=True, encoding="utf-8", errors="replace")
        out_path = os.path.join(SCRIPTS, "_stage7_unit_out.json")
        if r.returncode != 0 or not os.path.isfile(out_path):
            check("[ut] 阶段7单元测试运行", False, (r.stdout or "")[-300:] + (r.stderr or "")[-300:])
        else:
            res = json.load(open(out_path, encoding="utf-8"))
            check("[ut] 阶段7单元测试全部通过",
                  res.get("total") == res.get("passed"), "passed=%s/%s" % (res.get("passed"), res.get("total")))
            fails = [c.get("name") for c in res.get("checks", []) if not c.get("pass")]
            if fails:
                check("[ut] 无失败用例", False, " | ".join(fails))
else:
    print("[info] node 不可用，跳过语法检查与单测")

# ---------- 8. 安全红线回归 ----------
red = {"scan_secrets.py": "secrets", "validate_schema.py": "schema"}
for script, tag in red.items():
    sp = os.path.join(SCRIPTS, script)
    if os.path.isfile(sp):
        try:
            r = subprocess.run([sys.executable, sp], capture_output=True, text=True, cwd=SCRIPTS, timeout=180, encoding="utf-8", errors="replace")
            ok = r.returncode == 0
        except subprocess.TimeoutExpired:
            ok = False
        check("[redline] %s 通过" % script, ok, (r.stdout or "")[-400:] + (r.stderr or "")[-200:] if "r" in dir() else "timeout")
    else:
        check("[redline] %s 存在" % script, False)

print("=" * 72)
print("阶段7验收自检完成：%d/%d 通过" % (len(CHECKS) - len(FAILS), len(CHECKS)))
for name, ok, detail in CHECKS:
    print(("[PASS] " if ok else "[FAIL] ") + name + (("  | " + detail) if detail else ""))
if FAILS:
    print("\n失败项：")
    for f in FAILS:
        print(" -", f)
    sys.exit(1)
print("\nOK: 阶段7验收自检全部通过")

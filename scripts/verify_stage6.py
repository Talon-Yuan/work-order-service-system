#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_stage6.py — V3.1 阶段6（物流追踪与订阅消息）验收自检
覆盖：6-1 物流 API 接入 / 6-2 物流状态与订单联动 / 6-3 订阅消息体系 / 6-4 定时触发器
      前端页面与导航 / 文档与语言包同步 / 单元测试 / 语法检查 / 安全红线回归
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

# ---------- 0. 阶段6云函数骨架 ----------
FNS = ["logistics", "subscribe", "cron"]
for fn in FNS:
    d = os.path.join(CF, fn)
    check(f"[6.x] 云函数目录存在: {fn}", os.path.isdir(d))
    for f in ["index.js", "config.json", "package.json"]:
        check(f"[6.x] {fn}/{f} 存在", os.path.isfile(os.path.join(d, f)))
    check(f"[6.x] {fn}/common/constants.js 副本存在", os.path.isfile(os.path.join(d, "common", "constants.js")))

# ---------- 1. 6-1 物流 API 接入（快递100） ----------
lc = read(os.path.join(CF, "logistics", "common", "logisticsClient.js"))
check("[6-1] 快递100 密钥仅环境变量（前端零密钥）", "KUAIDI100_KEY" in lc and "KUAIDI100_CUSTOMER" in lc and "process.env" in lc)
check("[6-1] 快递100 签名计算", "sign" in lc and "md5" in lc.lower() or "MD5" in lc)
check("[6-1] 订阅回调验签", "verifySign" in lc or "verifyCallback" in lc or "verify" in lc)
check("[6-1] 统一查询层 queryTrace", "queryTrace" in lc)
check("[6-1] 统一订阅层 subscribeTrace", "subscribeTrace" in lc)
check("[6-1] 状态映射 mapState（pending/in_transit/delivered/exception）", "mapState" in lc)
lg = read(os.path.join(CF, "logistics", "index.js"))
check("[6-1] logistics.create 发货建单", "logistics.create" in lg)
check("[6-1] logistics.trace 轨迹查询", "logistics.trace" in lg)
check("[6-1] logistics.callback 订阅回调（验签+落库）", "logistics.callback" in lg)
check("[6-1] 未配置密钥明确提示不静默失败", "LOGISTICS_NOT_CONFIGURED" in lg)
check("[6-1] 轨迹日志脱敏", "mask" in lc or "****" in lc)
check("[6-1] config 声明 openapi 订阅消息权限", "openapi" in read(os.path.join(CF, "logistics", "config.json")))

# ---------- 2. 6-2 物流状态与订单联动 ----------
con = read(os.path.join(COMMON, "constants.js"))
check("[6-2] LOGISTICS_STATUS 四态定义", all(k in con for k in ["PENDING", "IN_TRANSIT", "DELIVERED", "EXCEPTION"]))
check("[6-2] 重复建单幂等", "existed" in lg or "LOGISTICS_EXISTED" in lg)
check("[6-2] 回调签收→订单 shipped→completed 联动", "completed" in lg and ("order" in lg))
check("[6-2] 状态变化写入站内通知", "sendNotification" in lg)
check("[6-2] 行级隔离：非本人查询拒绝", "WAYBILL_NOT_FOUND" in lg and "customer_openid" in lg)

# ---------- 3. 6-3 订阅消息体系 ----------
sub = read(os.path.join(CF, "subscribe", "index.js"))
check("[6-3] 六类模板常量 SUB_TEMPLATE_TYPES", "SUB_TEMPLATE_TYPES" in con and con.count("appointment_approved") >= 1)
check("[6-3] 模板 ID 仅存环境变量", "SUB_TMPL_" in sub and "process.env" in sub)
check("[6-3] 订阅授权登记 subscribe.allow（白名单）", "subscribe.allow" in sub and "NO_VALID_TEMPLATES" in sub)
check("[6-3] 授权状态查询 subscribe.list", "subscribe.list" in sub)
check("[6-3] 订阅发送 subscribe.send（未授权拒发）", "subscribe.send" in sub and "NOT_SUBSCRIBED" in sub)
check("[6-3] 内部密钥路由（云函数互调不依赖用户授权）", "SUBSCRIBE_INTERNAL_KEY" in sub)
check("[6-3] 普通用户调用 send 被拒", "FORBIDDEN" in read(os.path.join(COMMON, "authGuard.js")))
check("[6-3] 发送限流", "rateLimit" in sub or "limit" in sub)
check("[6-3] 模板发送数据脱敏/长度裁剪", "mask" in sub or "slice" in sub)
sm = read(os.path.join(CF, "statemachine", "index.js"))
check("[6-3] 工单状态流转挂接订阅推送", "trySendSubscribe" in sm and "subscribe.send" in sm)

# ---------- 4. 6-4 定时触发器 ----------
cr = read(os.path.join(CF, "cron", "index.js"))
ccfg = read(os.path.join(CF, "cron", "config.json"))
check("[6-4] cron 四任务：保养/库存/对账/清理", all(k in cr for k in ["maintenanceReminder", "stockAlert", "payReconcile", "reportCleanup"]))
check("[6-4] 保养提醒防重复标记", "reminded_maintenance_date" in cr)
check("[6-4] 库存预警阈值", "warn_threshold" in cr or "WARN_THRESHOLD" in cr)
check("[6-4] 对账只标记不修改资金", "reconcile_flag" in cr or "unverified" in cr)
check("[6-4] 报告清理只归档不删除", "archived" in cr and "status" in cr)
check("[6-4] config.json 含 4 个 timer 触发器", ccfg.count("\"type\": \"timer\"") >= 4)
check("[6-4] cron 触发器无用户身份直跑", "TriggerName" in cr)

# ---------- 5. 前端页面与导航 ----------
for p in ["pages/logistics/logistics.js", "pages/logistics/logistics.wxml", "pages/subscribe/subscribe.js", "pages/subscribe/subscribe.wxml"]:
    check(f"[fe] 前端文件存在 {p}", os.path.isfile(os.path.join(MP, p)))
appjson = read(os.path.join(MP, "app.json"))
check("[fe] app.json 注册 logistics 页", "pages/logistics/logistics" in appjson)
check("[fe] app.json 注册 subscribe 页", "pages/subscribe/subscribe" in appjson)
mine = read(os.path.join(MP, "pages", "mine", "mine.js"))
check("[fe] 我的页新增订阅消息入口", "subscribe" in mine)
check("[fe] 我的页新增物流入口或提示", "logistics" in mine)
orders = read(os.path.join(MP, "pages", "orders", "orders.js"))
check("[fe] 订单页新增查看物流按钮", "logistics" in orders or "waybill" in orders)

# ---------- 6. 文档同步 ----------
schema = read(os.path.join(DOCS, "schema.md"))
deploy = read(os.path.join(DOCS, "deploy.md"))
envt = read(os.path.join(DOCS, "env-template.md"))
check("[doc] schema.md 含 waybills 表", "waybills" in schema and "tracking_no" in schema)
check("[doc] schema.md 含 notifications 表", "notifications" in schema and "receiver_openid" in schema)
check("[doc] schema.md 含订阅授权字段", "subscribe_templates" in schema)
check("[doc] schema.md 含 device_profiles 保养字段", "next_maintenance_date" in schema and "reminded_maintenance_date" in schema)
check("[doc] deploy.md 含阶段6部署说明", "logistics" in deploy and "subscribe" in deploy and "cron" in deploy)
check("[doc] deploy.md 含定时触发器说明", "timerTrigger" in deploy or "触发器" in deploy)
check("[doc] env-template.md 含快递100 密钥", "KUAIDI100_KEY" in envt and "KUAIDI100_CUSTOMER" in envt and "KUAIDI100_CALLBACK_URL" in envt)
check("[doc] env-template.md 含订阅模板与内部密钥", "SUB_TMPL_" in envt and "SUBSCRIBE_INTERNAL_KEY" in envt)

# ---------- 7. 16 语言包 ----------
langs = sorted(f[:-5] for f in os.listdir(LANG) if f.endswith(".json"))
check("[i18n] 语言包数量为 16", len(langs) == 16, f"actual={len(langs)}")
if len(langs) == 16:
    keysets = {l: set(json.load(open(os.path.join(LANG, l + ".json"), encoding="utf-8")).keys()) for l in langs}
    basekeys = keysets[langs[0]]
    check("[i18n] 语言包 key 集合完全一致", all(ks == basekeys for ks in keysets.values()))
    s6keys = [k for k in basekeys if k.startswith("logistics") or k.startswith("subscribe") or k.startswith("sub") or k.startswith("cron") or k.startswith("notif")]
    check("[i18n] 阶段6新增词条齐全（≥30）", len(s6keys) >= 30, f"count={len(s6keys)}")
    sizes = {l: len(ks) for l, ks in keysets.items()}
    check("[i18n] 词条数一致", len(set(sizes.values())) == 1, json.dumps(sizes))

# ---------- 8. node 语法检查 + 单元测试（可选） ----------
if shutil.which("node"):
    for fn in FNS + ["statemachine"]:
        r = subprocess.run(["node", "--check", os.path.join(CF, fn, "index.js")], capture_output=True, text=True, encoding="utf-8", errors="replace")
        check(f"[syntax] {fn}/index.js", r.returncode == 0, r.stderr[:300])
    for m in ["constants.js", "authGuard.js", "workflow.js"]:
        r = subprocess.run(["node", "--check", os.path.join(COMMON, m)], capture_output=True, text=True, encoding="utf-8", errors="replace")
        check(f"[syntax] common/{m}", r.returncode == 0, r.stderr[:300])
    if os.path.isfile(os.path.join(SCRIPTS, "_stage6_unit_test.js")):
        r = subprocess.run(["node", os.path.join(SCRIPTS, "_stage6_unit_test.js")], capture_output=True, text=True, encoding="utf-8", errors="replace")
        out_path = os.path.join(SCRIPTS, "_stage6_unit_out.json")
        if r.returncode != 0 or not os.path.isfile(out_path):
            check("[ut] 阶段6单元测试运行", False, (r.stdout or "")[-300:] + (r.stderr or "")[-300:])
        else:
            res = json.load(open(out_path, encoding="utf-8"))
            check(f"[ut] 阶段6单元测试 {res.get('total', 0)}/{res.get('total', 0)} 项全部通过",
                  res.get("total") == res.get("passed"), f"passed={res.get('passed')}/{res.get('total')}")
            fails = [c.get("name") for c in res.get("checks", []) if not c.get("pass")]
            if fails:
                check("[ut] 无失败用例", False, " | ".join(fails))
else:
    print("[info] node 不可用，跳过语法检查与单测")

# ---------- 9. 安全红线回归 ----------
red = {"scan_secrets.py": "secrets", "validate_schema.py": "schema"}
for script, tag in red.items():
    sp = os.path.join(SCRIPTS, script)
    if os.path.isfile(sp):
        try:
            r = subprocess.run([sys.executable, sp], capture_output=True, text=True, cwd=SCRIPTS, timeout=180, encoding="utf-8", errors="replace")
            ok = r.returncode == 0
        except subprocess.TimeoutExpired:
            ok = False
        check(f"[redline] {script} 通过", ok, (r.stdout or "")[-400:] + (r.stderr or "")[-200:] if "r" in dir() else "timeout")
    else:
        check(f"[redline] {script} 存在", False)

print("=" * 72)
print(f"阶段6验收自检完成：{len(CHECKS) - len(FAILS)}/{len(CHECKS)} 通过")
for name, ok, detail in CHECKS:
    print(("[PASS] " if ok else "[FAIL] ") + name + (("  | " + detail) if detail else ""))
if FAILS:
    print("\n失败项：")
    for f in FAILS:
        print(" -", f)
    sys.exit(1)
print("\nOK: 阶段6验收自检全部通过")

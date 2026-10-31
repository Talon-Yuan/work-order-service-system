#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_stage9.py — V3.1 阶段9（安全自测、上线合规与交付）验收自检
覆盖：
  9-1 安全自测清单（docs/security-checklist.md）8 类全覆盖 + 可脚本化项 security_audit.py 通过
  9-2 上线合规清单（docs/compliance-checklist.md）6 项齐全
  9-3 全量回归：串联 verify_stage5~8.py + 跨阶段关联（成本/看板/订单库存联动/多语言页面引用）
  9-4 交付归档：docs 全套 + 部署脚本 + release/V3.1.0 版本目录 + MANIFEST 完整性
  9-5 上线后监控与响应（docs/monitoring-response.md）指标齐全
  红线回归：scan_secrets.py + validate_schema.py；node 语法检查；16 语言包一致性
依赖：python3 标准库；node 可选（语法检查）
"""
import os
import sys
import json
import re
import shutil
import subprocess

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
CF = os.path.join(ROOT, "cloudfunctions")
COMMON = os.path.join(CF, "common")
DOCS = os.path.join(ROOT, "docs")
SCRIPTS = os.path.join(ROOT, "scripts")
LANG = os.path.join(ROOT, "miniprogram", "utils", "lang")
MP = os.path.join(ROOT, "miniprogram")
WEB = os.path.join(ROOT, "web")
RELEASE = os.path.join(ROOT, "release")

FAILS = []
CHECKS = []

def check(name, ok, detail=""):
    CHECKS.append((name, bool(ok), detail))
    if not ok:
        FAILS.append(name)

def read(p):
    return open(p, encoding="utf-8", errors="replace").read()

def file_exists(*parts):
    return os.path.isfile(os.path.join(*parts))

# ---------- 0. 阶段9 文档三件套存在 ----------
DOC9 = {
    "security-checklist.md": "安全自测清单",
    "compliance-checklist.md": "上线合规检查清单",
    "monitoring-response.md": "上线后监控与响应",
}
for fn, label in DOC9.items():
    check("[9.x] docs/%s 存在（%s）" % (fn, label), file_exists(DOCS, fn))

# ---------- 1. 9-1 安全自测清单（8 类逐项留痕） ----------
sec = read(os.path.join(DOCS, "security-checklist.md")) if file_exists(DOCS, "security-checklist.md") else ""
S9_SECTIONS = {
    "越权测试（水平 × 垂直": "1. 越权",
    "注入测试": "2. 注入",
    "枚举测试": "3. 枚举",
    "支付安全测试": "4. 支付",
    "文件上传测试": "5. 上传",
    "密钥扫描": "6. 密钥",
    "数据库权限扫描": "7. 库权限",
    "发布清理": "8. 发布清理",
}
for kw, label in S9_SECTIONS.items():
    check("[9-1] 安全清单含 %s 章节" % label, kw in sec)
check("[9-1] 安全清单含水平/垂直越权", "水平越权" in sec and "垂直越权" in sec)
check("[9-1] 安全清单注入覆盖 $ne/$gt/$in/$or/超长/特殊字符", all(k in sec for k in ["$ne", "$gt", "$in", "$or", "超长字符串", "特殊字符"]))
check("[9-1] 安全清单支付覆盖伪造/篡改/重放/超时窗", all(k in sec for k in ["伪造回调", "篡改金额", "重放回调", "超时窗"]))
check("[9-1] 安全清单上传覆盖伪装/超大/可执行", all(k in sec for k in ["伪装扩展名", "超大文件", "可执行文件"]))
check("[9-1] 安全清单密钥覆盖 Git 历史与反编译", "Git 历史" in sec and "反编译" in sec)
check("[9-1] 安全清单留痕（实测结果列）", "实测结果" in sec and "留痕" in sec)
check("[9-1] 安全清单标注可脚本化配套", "security_audit.py" in sec and "scan_secrets.py" in sec and "validate_schema.py" in sec)

# ---------- 2. 9-2 上线合规清单（6 项） ----------
comp = read(os.path.join(DOCS, "compliance-checklist.md")) if file_exists(DOCS, "compliance-checklist.md") else ""
S9_COMPLIANCE = ["主体认证", "类目资质", "隐私保护指引", "订阅消息模板", "支付商户号", "服务器域名"]
for kw in S9_COMPLIANCE:
    check("[9-2] 合规清单含 %s" % kw, kw in comp)
check("[9-2] 合规清单含 https+ICP", "https" in comp and "ICP" in comp)
check("[9-2] 合规清单含提交审核汇总", "上线前提交清单" in comp and "审核" in comp)

# ---------- 3. 9-5 上线后监控与响应 ----------
mon = read(os.path.join(DOCS, "monitoring-response.md")) if file_exists(DOCS, "monitoring-response.md") else ""
check("[9-5] 监控文档含支付回调成功率指标", "支付回调成功率" in mon and "99%" in mon)
check("[9-5] 监控文档含云函数错误率指标", "云函数错误率" in mon)
check("[9-5] 监控文档含异常登录告警", "异常登录" in mon)
check("[9-5] 监控文档含日志审计巡检", "审计" in mon and "每周" in mon)
check("[9-5] 监控文档含密钥轮换周期", "密钥轮换" in mon and "90" in mon and "180" in mon)
check("[9-5] 监控文档含响应预案", "响应预案" in mon and "泄漏" in mon)

# ---------- 4. 可脚本化安全自测（security_audit.py 运行） ----------
sa = os.path.join(SCRIPTS, "security_audit.py")
check("[9-1] scripts/security_audit.py 存在", file_exists(SCRIPTS, "security_audit.py"))
if os.path.isfile(sa):
    try:
        r = subprocess.run([sys.executable, sa], capture_output=True, text=True, cwd=SCRIPTS, timeout=300, encoding="utf-8", errors="replace")
        ok = r.returncode == 0
        check("[9-1] security_audit.py 运行通过", ok, (r.stdout or "")[-500:] + (r.stderr or "")[-200:])
    except subprocess.TimeoutExpired:
        check("[9-1] security_audit.py 运行通过", False, "timeout")

# ---------- 5. 9-3 全量回归：串联 verify_stage5~8 ----------
REG = ["verify_stage5.py", "verify_stage6.py", "verify_stage7.py", "verify_stage8.py"]
for script in REG:
    sp = os.path.join(SCRIPTS, script)
    if os.path.isfile(sp):
        try:
            r = subprocess.run([sys.executable, sp], capture_output=True, text=True, cwd=SCRIPTS, timeout=600, encoding="utf-8", errors="replace")
            ok = r.returncode == 0
            tail = (r.stdout or "")[-300:].replace("\n", " | ")
            check("[9-3] 全量回归 %s 通过" % script, ok, tail)
        except subprocess.TimeoutExpired:
            check("[9-3] 全量回归 %s 通过" % script, False, "timeout")
    else:
        check("[9-3] 全量回归 %s 存在" % script, False)

# ---------- 6. 9-3 跨阶段关联影响核对 ----------
# 6a 订单/库存联动：order 云函数引用 inventoryOps 事务
order_js = read(os.path.join(CF, "order", "index.js")) if file_exists(CF, "order", "index.js") else ""
check("[9-3] 订单/库存联动：order 引用 inventoryOps/事务", "inventoryOps" in order_js and ("withTransaction" in order_js or "deductStock" in order_js))
# 6b 成本统计/看板：引用跨阶段数据源（以真实集合引用为准）
for fn, kws in [("cost-stats", ["COLLECTIONS.WORK_ORDERS", "COLLECTIONS.SYSTEM_CONFIG"]),
                ("dashboard", ["COLLECTIONS.WORK_ORDERS", "COLLECTIONS.SPARE_PARTS", "COLLECTIONS.APPOINTMENTS", "COLLECTIONS.STOCK_BATCHES"])]:
    p = os.path.join(CF, fn, "index.js")
    t = read(p) if os.path.isfile(p) else ""
    check("[9-3] %s 引用跨阶段数据源" % fn, all(k in t for k in kws))
# 6c 多语言改动后所有页面引用：页面注册齐全 + t() 引用的 key 存在
if file_exists(MP, "app.json"):
    appjson = read(os.path.join(MP, "app.json"))
    pages = re.findall(r'"pages/([\w\-/]+)"', appjson)
    check("[9-3] app.json 页面注册 ≥ 20", len(pages) >= 20, "count=%d" % len(pages))
    miss = []
    for pg in pages:
        for ext in (".js", ".wxml", ".json"):
            if not os.path.isfile(os.path.join(MP, "pages", pg + ext)):
                miss.append(pg + ext)
    check("[9-3] 全部注册页面文件齐全", not miss, "; ".join(miss[:10]))
    # t('key') / t("key") 引用检查
    basekeys = set()
    zh = os.path.join(LANG, "zh-CN.json")
    if os.path.isfile(zh):
        basekeys = set(json.load(open(zh, encoding="utf-8")).keys())
    ref_missing = []
    for dirpath, dirnames, filenames in os.walk(os.path.join(MP, "pages")):
        for fn in filenames:
            if not fn.endswith(".js"):
                continue
            fp = os.path.join(dirpath, fn)
            text = read(fp)
            for m in re.finditer(r"\bt\(\s*['\"]([^'\"]+)['\"]\s*\)", text):
                if m.group(1) not in basekeys:
                    ref_missing.append("%s: t('%s')" % (os.path.relpath(fp, MP), m.group(1)))
    check("[9-3] 页面 t() 引用 key 均在语言包存在", not ref_missing, "; ".join(ref_missing[:10]))
    # 页面 navigateTo/redirectTo 引用页面均在 app.json 注册
    nav_missing = []
    for dirpath, dirnames, filenames in os.walk(os.path.join(MP, "pages")):
        for fn in filenames:
            if not fn.endswith(".js"):
                continue
            fp = os.path.join(dirpath, fn)
            text = read(fp)
            for m in re.finditer(r"url:\s*['\"]/pages/([\w\-/]+)['\"]", text):
                target = m.group(1)
                if target not in pages and target.split("?")[0] not in pages:
                    nav_missing.append("%s -> %s" % (os.path.relpath(fp, MP), target))
    check("[9-3] 页面导航目标均在 app.json 注册", not nav_missing, "; ".join(nav_missing[:10]))
else:
    check("[9-3] app.json 存在", False)

# ---------- 7. 9-4 交付归档完整性 ----------
check("[9-4] release/V3.1.0 版本目录存在", os.path.isdir(os.path.join(RELEASE, "V3.1.0")))
check("[9-4] MANIFEST.md 存在且含版本号 V3.1.0", file_exists(RELEASE, "V3.1.0", "MANIFEST.md") and "V3.1.0" in read(os.path.join(RELEASE, "V3.1.0", "MANIFEST.md")))
check("[9-4] 部署脚本 deploy_all.ps1 存在", file_exists(SCRIPTS, "deploy_all.ps1"))
DOC_ALL = ["schema.md", "database-security.md", "deploy.md", "env-template.md",
           "security-checklist.md", "compliance-checklist.md", "monitoring-response.md"]
for fn in DOC_ALL:
    check("[9-4] docs/%s 归档存在" % fn, file_exists(DOCS, fn))
check("[9-4] MANIFEST 含新工程师独立部署路径", "独立部署" in read(os.path.join(RELEASE, "V3.1.0", "MANIFEST.md")) if file_exists(RELEASE, "V3.1.0", "MANIFEST.md") else False)

# ---------- 8. 16 语言包一致性 ----------
langs = sorted(f[:-5] for f in os.listdir(LANG) if f.endswith(".json"))
check("[i18n] 语言包数量为 16", len(langs) == 16, "actual=%d" % len(langs))
if len(langs) == 16:
    keysets = {l: set(json.load(open(os.path.join(LANG, l + ".json"), encoding="utf-8")).keys()) for l in langs}
    basekeys = keysets[langs[0]]
    check("[i18n] 语言包 key 集合完全一致", all(ks == basekeys for ks in keysets.values()))
    check("[i18n] 词条数 = 314（阶段8基线，阶段9无新增语言）", len(basekeys) == 314, "count=%d" % len(basekeys))

# ---------- 9. 红线回归 ----------
red = {"scan_secrets.py": "密钥残留", "validate_schema.py": "数据库权限"}
for script, tag in red.items():
    sp = os.path.join(SCRIPTS, script)
    if os.path.isfile(sp):
        try:
            r = subprocess.run([sys.executable, sp], capture_output=True, text=True, cwd=SCRIPTS, timeout=240, encoding="utf-8", errors="replace")
            check("[redline] %s 通过（%s）" % (script, tag), r.returncode == 0, (r.stdout or "")[-300:])
        except subprocess.TimeoutExpired:
            check("[redline] %s 通过（%s）" % (script, tag), False, "timeout")
    else:
        check("[redline] %s 存在" % script, False)

# ---------- 10. node 语法检查（云函数 + common + 页面 + Web） ----------
if shutil.which("node"):
    syntax_targets = []
    # 全部云函数 index.js
    for d in os.listdir(CF):
        fp = os.path.join(CF, d, "index.js")
        if os.path.isfile(fp):
            syntax_targets.append(fp)
    # common 公共模块
    for m in os.listdir(COMMON):
        if m.endswith(".js"):
            syntax_targets.append(os.path.join(COMMON, m))
    # 小程序页面 js
    for dirpath, dirnames, filenames in os.walk(os.path.join(MP, "pages")):
        for fn in filenames:
            if fn.endswith(".js"):
                syntax_targets.append(os.path.join(dirpath, fn))
    # Web app.js
    for dirpath, dirnames, filenames in os.walk(WEB):
        for fn in filenames:
            if fn == "app.js":
                syntax_targets.append(os.path.join(dirpath, fn))
    bad = []
    for fp in syntax_targets:
        r = subprocess.run(["node", "--check", fp], capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode != 0:
            bad.append("%s: %s" % (os.path.relpath(fp, ROOT), (r.stderr or "")[:160].replace("\n", " ")))
    check("[syntax] node --check 全部 js 通过（%d 个文件）" % len(syntax_targets), not bad, "; ".join(bad[:10]))
else:
    print("[info] node 不可用，跳过语法检查")

print("=" * 72)
print("阶段9验收自检完成：%d/%d 通过" % (len(CHECKS) - len(FAILS), len(CHECKS)))
for name, ok, detail in CHECKS:
    print(("[PASS] " if ok else "[FAIL] ") + name + (("  | " + detail) if detail else ""))
if FAILS:
    print("\n失败项：")
    for f in FAILS:
        print(" -", f)
    sys.exit(1)
print("\nOK: 阶段9验收自检全部通过")

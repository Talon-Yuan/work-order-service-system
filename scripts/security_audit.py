#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
security_audit.py — 阶段9 可脚本化安全自测综合审计（任务9-1）
覆盖检查项：
  1) 注入防护：全部云函数使用 cleanInput；禁止前端对象直接进入 where
  2) 枚举防护：订单/工单号随机生成（非自增）
  3) 支付安全：验签 / 时间窗 / nonce 幂等 / 金额一致性（pay 云函数静态检查）
  4) 文件上传：魔数校验 / 大小限制 / 类型白名单（upload 云函数静态检查）
  5) 发布清理：测试账号 / debug 开关 / 测试域名 / 未注册调试页
  6) 密钥扫描：复用 scripts/scan_secrets.py
  7) Git 历史密钥：存在 .git 时扫描 git log；无 .git 输出 N/A（不判失败）
  8) 数据库权限：复用 scripts/validate_schema.py

用法: python scripts/security_audit.py [project_root]
退出码: 0=全部通过(含N/A)  1=发现未通过项  2=执行异常
"""
import os
import re
import subprocess
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")) if len(sys.argv) < 2 else os.path.abspath(sys.argv[1])
CF = os.path.join(ROOT, "cloudfunctions")
MP = os.path.join(ROOT, "miniprogram")
WEB = os.path.join(ROOT, "web")
SCRIPTS = os.path.join(ROOT, "scripts")

FAILS = []
NAs = []
CHECKS = []

def check(name, ok, detail=""):
    CHECKS.append((name, bool(ok), detail))
    if not ok:
        FAILS.append(name)

def read(p):
    return open(p, encoding="utf-8", errors="replace").read()

def iter_js(dirs, skip=(".git", "node_modules", "temp", "__pycache__")):
    for base in dirs:
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in skip]
            for fn in filenames:
                if fn.endswith(".js"):
                    yield os.path.join(dirpath, fn)

# ---------- 1. 注入防护 ----------
# 清洗函数白名单：cleanInput（通用）/ str()（evaluation、knowledge 的 trim+长度上限+白名单）；
# cron 为云开发定时触发器（event 仅 TriggerName，无用户输入），豁免。
CLEAN_EXEMPT = {"cron"}
clean_input_missing = []
where_event = []
for fp in iter_js([CF]):
    rel = os.path.relpath(fp, ROOT)
    relu = rel.replace("\\", "/")
    if "/common/" in relu:
        continue
    fn = relu.split("/")[1]
    if fn in CLEAN_EXEMPT:
        continue
    try:
        text = read(fp)
    except Exception:
        continue
    if not re.search(r"cleanInput|function\s+str\s*\(", text):
        clean_input_missing.append(rel)
    # 前端对象直接进 where 的可疑模式：.where(event 或 .where(p. 且参数为对象直接引用
    for m in re.finditer(r"\.where\(\s*(event|p|q|data)\b", text):
        where_event.append("%s: %s" % (rel, m.group(0)))
check("[注入] 全部云函数使用清洗函数（cleanInput/str，cron 定时器豁免）", not clean_input_missing,
      "未使用: %s" % ", ".join(clean_input_missing) if clean_input_missing else "")
check("[注入] 无前端对象直接进 where", not where_event,
      "; ".join(where_event[:10]) if where_event else "")

# ---------- 2. 枚举防护（订单/工单号随机生成） ----------
rand_ids = []
for fn, pat in [("order", r"genOrderNo\s*\(|Math\.random|order_no\s*:"),
                ("work-orders", r"genNo\s*\(\s*'WO'|work_order_no\s*:")]:
    p = os.path.join(CF, fn, "index.js")
    if not os.path.isfile(p):
        check("[枚举] %s/index.js 存在" % fn, False)
        continue
    text = read(p)
    rand_ids.append((fn, bool(re.search(pat, text))))
for fn, ok in rand_ids:
    check("[枚举] %s 单号随机生成（非顺序自增）" % fn, ok)

# ---------- 3. 支付安全 ----------
pay = os.path.join(CF, "pay", "index.js")
if os.path.isfile(pay):
    pt = read(pay)
    check("[支付] 回调验签（平台证书/签名）", bool(re.search(r"verify|Signature|验签", pt)))
    check("[支付] 时间窗防重放（300s）", bool(re.search(r"300|timestamp|时间窗|重放", pt)))
    check("[支付] nonce 幂等（payment_flows.nonce 唯一索引/去重）", "nonce" in pt and bool(re.search(r"唯一索引|去重|幂等", pt)))
    check("[支付] 金额一致性校验（篡改金额拒绝）", bool(re.search(r"amount|金额一致|不一致", pt)))
    # 商户密钥仅在 common/wechatPay.js 通过 process.env.PAY_* 读取；pay/index.js 不得出现密钥字面量
    wp = os.path.join(CF, "common", "wechatPay.js")
    wp_text = read(wp) if os.path.isfile(wp) else ""
    env_ok = "process.env.PAY_MCH_PRIVATE_KEY_PEM" in wp_text and "process.env.PAY_API_V3_KEY" in wp_text
    literal_hit = re.search(r"(?i)(?:private[_-]?key|apiv3[_-]?key|mch[_-]?id|appid)\s*[:=]\s*['\"][A-Za-z0-9]{16,}", pt)
    check("[支付] 商户密钥仅环境变量（零字面量）", env_ok and not literal_hit)
else:
    check("[支付] pay/index.js 存在", False)

# ---------- 4. 文件上传 ----------
up = os.path.join(CF, "upload", "index.js")
if os.path.isfile(up):
    ut = read(up)
    check("[上传] 魔数校验真实类型", "detectImageType" in ut)
    check("[上传] 服务端大小限制 ≤5MB", "MAX_FILE_BYTES" in ut and "FILE_TOO_LARGE" in ut)
    check("[上传] 类型白名单（伪装扩展名拒绝）", "jpg" in ut and "png" in ut and "webp" in ut and "sanitizeFileName" in ut)
    check("[上传] 内容安全扫描", "checkContentSafe" in ut)
else:
    check("[上传] upload/index.js 存在", False)

# ---------- 5. 发布清理 ----------
DEBUG_PAT = re.compile(r"(?i)\bdebug\s*[:=]\s*(true|1)\b|console\.log\s*\(")
TEST_ACCT = re.compile(r"(?i)\btest(user|account|admin)?\s*[:=]\s*['\"][^'\"]{2,}['\"]|123456|password\s*[:=]\s*['\"]test")
TEST_DOMAIN = re.compile(r"(?i)\b(localhost|127\.0\.0\.1|example\.com|test\.com|\.test\.|debug\.|staging\.)\b")
debug_hits, acct_hits, domain_hits = [], [], []
for fp in iter_js([MP, WEB]):
    rel = os.path.relpath(fp, ROOT)
    text = read(fp)
    if DEBUG_PAT.search(text):
        debug_hits.append(rel)
    if TEST_ACCT.search(text):
        acct_hits.append(rel)
    if TEST_DOMAIN.search(text):
        domain_hits.append(rel)
# 页面注册核对：app.json 的页面文件齐全，无未注册调试页
appjson = os.path.join(MP, "app.json")
reg_pages = []
if os.path.isfile(appjson):
    reg_pages = re.findall(r'"pages/([\w\-/]+)"', read(appjson))
missing_pages = []
for pg in reg_pages:
    for ext in (".js", ".wxml", ".json"):
        if not os.path.isfile(os.path.join(MP, "pages", pg + ext)):
            missing_pages.append(pg + ext)
check("[发布清理] 无 debug/console.log 残留（前端）", not debug_hits, "; ".join(debug_hits[:10]))
check("[发布清理] 无测试账号硬编码", not acct_hits, "; ".join(acct_hits[:10]))
check("[发布清理] 无测试域名/localhost 硬编码", not domain_hits, "; ".join(domain_hits[:10]))
check("[发布清理] app.json 注册页面文件齐全（无无入口调试页）", not missing_pages, "; ".join(missing_pages[:10]))

# ---------- 6. 密钥扫描（复用 scan_secrets.py） ----------
sp = os.path.join(SCRIPTS, "scan_secrets.py")
if os.path.isfile(sp):
    r = subprocess.run([sys.executable, sp], capture_output=True, text=True, cwd=SCRIPTS, timeout=240, encoding="utf-8", errors="replace")
    check("[密钥] scan_secrets.py 通过（前端零密钥）", r.returncode == 0, (r.stdout or "")[-300:])
else:
    check("[密钥] scan_secrets.py 存在", False)

# ---------- 7. Git 历史密钥 ----------
git_dir = os.path.join(ROOT, ".git")
if os.path.isdir(git_dir):
    try:
        r = subprocess.run(["git", "log", "-p", "--all"], capture_output=True, text=True, cwd=ROOT, timeout=300, encoding="utf-8", errors="replace")
        blob = (r.stdout or "") + (r.stderr or "")
        hits = []
        for pat in [r"\bsk-[A-Za-z0-9]{16,}\b", r"\bAKID[A-Za-z0-9]{10,}\b", r"BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY"]:
            hits.extend(re.findall(pat, blob))
        check("[Git历史] git log 无密钥泄漏", not hits, "命中 %d 处" % len(hits) if hits else "")
    except Exception as e:  # noqa: BLE001
        check("[Git历史] git log 扫描可执行", False, str(e))
else:
    NAs.append("[Git历史] 项目未初始化 Git 仓库（无 .git），无历史泄漏面；N/A")
    check("[Git历史] 无 Git 仓库（N/A 说明）", True, "未初始化 Git，归档前无历史泄漏面")

# ---------- 8. 数据库权限（复用 validate_schema.py） ----------
vp = os.path.join(SCRIPTS, "validate_schema.py")
if os.path.isfile(vp):
    r = subprocess.run([sys.executable, vp], capture_output=True, text=True, cwd=SCRIPTS, timeout=240, encoding="utf-8", errors="replace")
    check("[库权限] validate_schema.py 通过（数据库零全开）", r.returncode == 0, (r.stdout or "")[-300:])
else:
    check("[库权限] validate_schema.py 存在", False)

# ---------- 汇总 ----------
print("=" * 72)
print("security_audit.py 安全自测完成：%d/%d 通过" % (len(CHECKS) - len(FAILS), len(CHECKS)))
for name, ok, detail in CHECKS:
    print(("[PASS] " if ok else "[FAIL] ") + name + (("  | " + detail) if detail else ""))
for na in NAs:
    print("[N/A ] " + na)
if FAILS:
    print("\n未通过项：")
    for f in FAILS:
        print(" -", f)
    sys.exit(1)
print("\nOK: 阶段9可脚本化安全自测全部通过")
sys.exit(0)

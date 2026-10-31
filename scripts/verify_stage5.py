#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_stage5.py — V3.1 阶段5（工单闭环与服务报告）静态验收自检
覆盖：5-1 工单创建与进度 / 5-2 文件上传安全 / 5-3 验收闭环与 PDF 报告 / 5-4 状态机与消息
依赖：python3 标准库；若本机有 node 则额外做语法检查
"""
import os
import sys
import json
import shutil

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
CF = os.path.join(ROOT, "cloudfunctions")
DOCS = os.path.join(ROOT, "docs")
SCRIPTS = os.path.join(ROOT, "scripts")
LANG = os.path.join(ROOT, "miniprogram", "utils", "lang")

FAILS = []
CHECKS = []

def check(name, ok, detail=""):
    CHECKS.append((name, bool(ok), detail))
    if not ok:
        FAILS.append(name)

def read(p):
    return open(p, encoding="utf-8").read()

# ---------- 0. 前置：五个云函数存在 ----------
FNS = ["work-orders", "upload", "accept", "report", "statemachine"]
for fn in FNS:
    d = os.path.join(CF, fn)
    check(f"[5.x] 云函数目录存在: {fn}", os.path.isdir(d))
    check(f"[5.x] {fn}/index.js 存在", os.path.isfile(os.path.join(d, "index.js")))
    check(f"[5.x] {fn}/config.json 存在", os.path.isfile(os.path.join(d, "config.json")))
    check(f"[5.x] {fn}/package.json 存在", os.path.isfile(os.path.join(d, "package.json")))

# ---------- 1. 5-1 工单创建与施工进度 ----------
wo = read(os.path.join(CF, "work-orders", "index.js"))
check("[5-1] wo.create 动作入口", "wo.create" in wo)
check("[5-1] 创建时初始化标准步骤", "sign" in wo and "detect" in wo and "construct" in wo and "accept" in wo)
check("[5-1] 创建时写入 audit_logs", "audit_logs" in wo)
check("[5-1] 进度追加动作 wo.progress", "wo.progress" in wo)
check("[5-1] 进度追加写审计", wo.count("writeAudit") >= 2)
check("[5-1] 进度照片分类数组 photos", "photos" in wo and "photo" in wo)
check("[5-1] 进度追加禁前端直写（服务端校验归属）", "engineer_openid" in wo and "operator_openid" in wo)

# ---------- 2. 5-2 文件上传安全 ----------
up = read(os.path.join(CF, "upload", "index.js"))
upg = read(os.path.join(CF, "common", "uploadGuard.js"))
check("[5-2] 前端限类型/大小由云函数二次校验（魔数）", ("magic" in up) or ("MAGIC" in upg))
check("[5-2] 图片 ≤5MB 硬限制", "MAX_FILE_BYTES" in upg and ("5 * 1024 * 1024" in upg or "5242880" in upg))
check("[5-2] 内容安全扫描 msgSecCheck/imgSecCheck", ("msgSecCheck" in up) and ("imgSecCheck" in up))
check("[5-2] 违规拒绝并记录", ("rejected" in up) and ("upload_logs" in up))
check("[5-2] 文件名清洗去路径符+随机名", ("basename" in up or "replace" in upg) and ("random" in up or "Date.now" in up))
check("[5-2] 私有读+临时链接仅授权用户", ("tempUrl" in up) and ("private" in up or "fileID" in up))
check("[5-2] 上传频率限制", "freq" in upg or "rateLimit" in upg)
check("[5-2] 单用户容量限制", "quota" in upg or "quota" in up)

# ---------- 3. 5-3 验收闭环与服务报告 ----------
ac = read(os.path.join(CF, "accept", "index.js"))
check("[5-3] 客户电子签名验收 wo.accept", "wo.accept" in ac)
check("[5-3] openid 匹配工单关联客户（越权拒绝）", ("customer_openid" in ac) and ("NOT_WO_OWNER" in ac or "WO_NOT_ACCESSIBLE" in ac or "openid" in ac))
check("[5-3] 驳回动作 wo.reject", "wo.reject" in ac)
check("[5-3] 签名归属校验", "signature" in ac or "signature_file_id" in ac)

rp = read(os.path.join(CF, "report", "index.js"))
check("[5-3] report.generate 动作", "report.generate" in rp)
check("[5-3] 云函数端 PDF 模板渲染", ("pdfkit" in rp) or ("PDFDocument" in rp))
check("[5-3] 报告要素：设备/工单/方案/结果/双签", all(k in rp for k in ["device", "work_order", "summary", "result", "sign"]))
check("[5-3] PDF 存云存储私有读", ("workorder-files/reports" in rp or "reports/" in rp) and ("uploadFile" in rp or "cloudPath" in rp))
check("[5-3] 报告元数据+可导出（临时链接）", ("report.get" in rp) and ("tempUrl" in rp or "getTempFileURL" in rp))

# ---------- 4. 5-4 状态机与消息 ----------
sm = read(os.path.join(CF, "statemachine", "index.js"))
wf = read(os.path.join(CF, "common", "workflow.js"))
check("[5-4] 状态机动作 wo.transition", "wo.transition" in sm)
check("[5-4] 五态链定义 pending→processing→pending_acceptance→accepted/rejected→closed", all(k in wf for k in ["pending", "processing", "pending_acceptance", "accepted", "rejected", "closed"]))
check("[5-4] 状态不可跳级", ("INVALID_TRANSITION" in wf) or ("no jump" in wf) or ("assertTransition" in wf))
check("[5-4] 非法流转拒绝", ("assertTransition" in sm) or ("INVALID_TRANSITION" in sm))
check("[5-4] 验收后评价邀请 notifications", ("sendNotification" in wf) and (("evaluation" in ac and "sendNotification" in ac) or ("evaluation" in sm and "sendNotification" in sm)))

# ---------- 5. 文档同步 ----------
schema = read(os.path.join(DOCS, "schema.md"))
deploy = read(os.path.join(DOCS, "deploy.md"))
envt = read(os.path.join(DOCS, "env-template.md"))
check("[doc] schema.md 含 work_orders 新状态机", "pending_acceptance" in schema and "accepted" in schema and "closed" in schema)
check("[doc] schema.md 含 work_steps.photos", "photos" in schema)
check("[doc] schema.md 含 reports PDF 私有读定义", "report_no" in schema and "file_id" in schema and "valid" in schema)
check("[doc] schema.md 含 upload_logs", "upload_logs" in schema)
check("[doc] deploy.md 含阶段5部署", "work-orders" in deploy and "statemachine" in deploy)
check("[doc] env-template.md 含 contentCheck/上传配置", "msgSecCheck" in envt and "upload.limit" in envt)

# ---------- 6. 16 语言包 ----------
langs = sorted(f[:-5] for f in os.listdir(LANG) if f.endswith(".json"))
check("[i18n] 语言包数量为 16", len(langs) == 16, f"actual={len(langs)}")
if len(langs) == 16:
    sizes = {l: len(json.load(open(os.path.join(LANG, l + ".json"), encoding="utf-8"))) for l in langs}
    check("[i18n] 全部语言包 ≥168 词条（138+30）", all(v >= 168 for v in sizes.values()), json.dumps(sizes))
    check("[i18n] 语言包词条数一致", len(set(sizes.values())) == 1, json.dumps(sizes))

# ---------- 7. node 语法检查（可选） ----------
if shutil.which("node"):
    import subprocess
    for fn in FNS:
        r = subprocess.run(["node", "--check", os.path.join(CF, fn, "index.js")], capture_output=True, text=True)
        check(f"[syntax] {fn}/index.js", r.returncode == 0, r.stderr[:300])
    for m in ["workflow.js", "uploadGuard.js"]:
        r = subprocess.run(["node", "--check", os.path.join(CF, "common", m)], capture_output=True, text=True)
        check(f"[syntax] common/{m}", r.returncode == 0, r.stderr[:300])
else:
    print("[info] node 不可用，跳过语法检查")

print("=" * 64)
print(f"阶段5验收自检完成：{len(CHECKS) - len(FAILS)}/{len(CHECKS)} 通过")
for name, ok, detail in CHECKS:
    print(("[PASS] " if ok else "[FAIL] ") + name + (("  | " + detail) if detail else ""))
if FAILS:
    print("\n失败项：")
    for f in FAILS:
        print(" -", f)
    sys.exit(1)
print("\nOK: 阶段5验收自检全部通过")

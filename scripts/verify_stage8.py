#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_stage8.py — V3.1 阶段8（服务评价与知识库）验收自检
覆盖：8-1 服务评价提交/查看/满意度统计 + 回访计划
      8-2 知识库两级可见隔离与越权防护（public/internal）
      8-3 前端页面（小程序 review/knowledge/knowledge-detail + Web 管理端）
      8-4 越权与安全红线回归 / 文档同步 / 16 语言包一致性 / 单元测试 / 语法检查
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
WEB = os.path.join(ROOT, "web")

FAILS = []
CHECKS = []

def check(name, ok, detail=""):
    CHECKS.append((name, bool(ok), detail))
    if not ok:
        FAILS.append(name)

def read(p):
    return open(p, encoding="utf-8").read()

# ---------- 0. 阶段8云函数骨架 ----------
FNS = ["evaluation", "knowledge"]
for fn in FNS:
    d = os.path.join(CF, fn)
    check("[8.x] 云函数目录存在: %s" % fn, os.path.isdir(d))
    for f in ["index.js", "config.json", "package.json"]:
        check("[8.x] %s/%s 存在" % (fn, f), os.path.isfile(os.path.join(d, f)))
    check("[8.x] %s/common/constants.js 副本存在" % fn, os.path.isfile(os.path.join(d, "common", "constants.js")))
    check("[8.x] %s/common/authGuard.js 副本存在" % fn, os.path.isfile(os.path.join(d, "common", "authGuard.js")))

con = read(os.path.join(COMMON, "constants.js"))
S8_ACTIONS = ["EVAL_CREATE", "EVAL_LIST", "EVAL_STATS", "VISIT_CREATE", "VISIT_LIST", "VISIT_RECORD",
              "KNOWLEDGE_LIST", "KNOWLEDGE_DETAIL", "KNOWLEDGE_CREATE", "KNOWLEDGE_UPDATE",
              "KNOWLEDGE_DELETE", "KNOWLEDGE_FROM_WO"]
for k in S8_ACTIONS:
    check("[8.x] ACTIONS.%s 已定义" % k, (k + ":") in con)

# ---------- 1. 8-1 服务评价与回访 ----------
ev = read(os.path.join(CF, "evaluation", "index.js"))
check("[8-1] eval.create 动作路由（评价提交）", "eval.create" in ev)
check("[8-1] eval.list 动作路由（评价列表）", "eval.list" in ev)
check("[8-1] eval.stats 动作路由（满意度统计）", "eval.stats" in ev)
check("[8-1] 仅 accepted/closed 工单可评", "EVAL_ALLOWED_STATUS" in ev and "WO_STATUS.ACCEPTED" in ev and "WO_STATUS.CLOSED" in ev)
check("[8-1] 同一工单唯一评价（防重复）", "EVAL_ALREADY_EXISTS" in ev and "dup" in ev)
check("[8-1] 行级越权：非本人工单拒绝", "WORK_ORDER_NOT_ACCESSIBLE" in ev and "wo.customer_openid !== openid" in ev)
check("[8-1] 评分 1-5 整数校验", "rating < 1 || rating > 5" in ev and "Number.isInteger(rating)" in ev)
check("[8-1] 标签白名单 EVAL_TAGS", "EVAL_TAGS" in ev and "professional" in ev and "punctual" in ev and "polite" in ev and "price" in ev)
check("[8-1] 内容清洗（trim+长度上限）", "function str(v, max)" in ev and "slice(0, max" in ev)
check("[8-1] 客户 openid 服务端写入（禁前端传入）", "customer_openid: openid" in ev and "engineer_openid: wo.engineer_openid" in ev)
check("[8-1] 提交接口限流", "checkRateLimit" in ev and "TOO_FREQUENT" in ev)
check("[8-1] 评价写审计", "writeAudit" in ev and "eval.create" in ev)
check("[8-1] 列表按角色行级隔离（客户=本人/工程师=被评）", "role === ROLES.CUSTOMER" in ev and "where.customer_openid = openid" in ev and "where.engineer_openid = openid" in ev)
check("[8-1] 列表 openid 脱敏", "maskOpenid" in ev)
check("[8-1] 统计按角色过滤（工程师仅本人被评）", "role === ROLES.ENGINEER" in ev and "match.engineer_openid = openid" in ev)
check("[8-1] 统计含 1-5 分布/均值/TOP10", "dist" in ev and "avg_rating" in ev and "top_engineers" in ev and "limit(10)" in ev)
check("[8-1] visit.create 动作路由（回访计划）", "visit.create" in ev)
check("[8-1] visit.list 动作路由（回访列表）", "visit.list" in ev)
check("[8-1] visit.record 动作路由（回访记录）", "visit.record" in ev)
check("[8-1] 回访 owner_openid 服务端写入", "owner_openid: openid" in ev)
check("[8-1] 回访目标客户校验（users 存在）", "CUSTOMER_NOT_FOUND" in ev and "COLLECTIONS.USERS" in ev)
check("[8-1] 回访状态机 pending->done/skipped", "VISIT_STATUS" in ev and "status === VISIT_STATUS.PENDING" in ev)
check("[8-1] 回访记录写审计", "writeAudit" in ev and "visit.record" in ev)

# ---------- 2. 8-2 知识库两级可见隔离与越权防护 ----------
kn = read(os.path.join(CF, "knowledge", "index.js"))
check("[8-2] knowledge.list 动作路由", "knowledge.list" in kn)
check("[8-2] knowledge.detail 动作路由", "knowledge.detail" in kn)
check("[8-2] knowledge.create 动作路由", "knowledge.create" in kn)
check("[8-2] knowledge.update 动作路由", "knowledge.update" in kn)
check("[8-2] knowledge.delete 动作路由", "knowledge.delete" in kn)
check("[8-2] knowledge.from_wo 动作路由（工单沉淀）", "knowledge.from_wo" in kn)
check("[8-2] 两级可见判定函数 canSee（internal 仅内部角色）", "function canSee(role, doc)" in kn and "VISIBILITY.INTERNAL" in kn and "role === ROLES.OWNER || role === ROLES.ENGINEER" in kn)
check("[8-2] 客户仅 public+published（canSee 前置校验）", "role === ROLES.CUSTOMER" in kn and "doc.status === ARTICLE_STATUS.PUBLISHED" in kn)
check("[8-2] 客户查询条件双重隔离 baseWhere", "function baseWhere(role" in kn and "visibility: VISIBILITY.PUBLIC" in kn and "status: ARTICLE_STATUS.PUBLISHED" in kn)
check("[8-2] 越权读 internal 详情返回 403", "ARTICLE_NOT_ACCESSIBLE" in kn and "if (!canSee(role, doc)) return fail(403" in kn)
check("[8-2] 客户列表隐藏内部字段（content/files 置空）", "role === ROLES.CUSTOMER ? '' : (x.content" in kn and "role === ROLES.CUSTOMER ? [] : (x.files" in kn)
check("[8-2] 作者 openid 服务端写入", "author_openid: openid" in kn)
check("[8-2] 字段白名单 WRITABLE_FIELDS", "WRITABLE_FIELDS" in kn and "title" in kn and "visibility" in kn and "status" in kn and "content" in kn)
check("[8-2] 分类枚举校验 CATEGORIES", "CATEGORIES" in kn and "guide" in kn and "faq" in kn and "tutorial" in kn and "policy" in kn)
check("[8-2] 状态枚举 draft/published/archived", "ARTICLE_STATUS" in kn and "DRAFT" in kn and "PUBLISHED" in kn and "ARCHIVED" in kn)
check("[8-2] 详情浏览量自增", "view_count" in kn and "db.command.inc(1)" in kn)
check("[8-2] 首次发布落 published_at / 退回草稿清空", "data.published_at = now" in kn and "data.published_at = null" in kn)
check("[8-2] 写操作全部审计", "writeAudit" in kn and "knowledge.create" in kn and "knowledge.update" in kn and "knowledge.delete" in kn and "knowledge.from_wo" in kn)
check("[8-2] 工单沉淀不落敏感 openid 且默认草稿", "tags: ['case']" in kn and "status: ARTICLE_STATUS.DRAFT" in kn and "author_openid: openid" in kn)
check("[8-2] 关键词搜索转义防注入", "escapeRegex" in kn and "db.RegExp" in kn)

# ---------- 3. 8-3 前端页面（小程序 + Web） ----------
for p in ["pages/review/review.js", "pages/review/review.wxml", "pages/review/review.wxss", "pages/review/review.json",
          "pages/knowledge/knowledge.js", "pages/knowledge/knowledge.wxml", "pages/knowledge/knowledge.wxss", "pages/knowledge/knowledge.json",
          "pages/knowledge-detail/knowledge-detail.js", "pages/knowledge-detail/knowledge-detail.wxml",
          "pages/knowledge-detail/knowledge-detail.wxss", "pages/knowledge-detail/knowledge-detail.json"]:
    check("[fe] 小程序页面文件存在 %s" % p, os.path.isfile(os.path.join(MP, p)))
appjson = read(os.path.join(MP, "app.json"))
check("[fe] app.json 注册 review 页", "pages/review/review" in appjson)
check("[fe] app.json 注册 knowledge 页", "pages/knowledge/knowledge" in appjson)
check("[fe] app.json 注册 knowledge-detail 页", "pages/knowledge-detail/knowledge-detail" in appjson)
mine = read(os.path.join(MP, "pages", "mine", "mine.wxml"))
minejs = read(os.path.join(MP, "pages", "mine", "mine.js"))
check("[fe] 我的页含评价入口", "onGoReview" in mine and "myEvaluation" in minejs)
check("[fe] 我的页含知识库入口", "onGoKnowledge" in mine and "myKnowledge" in minejs)
rjs = read(os.path.join(MP, "pages", "review", "review.js"))
check("[fe] 评价页调用 eval.create/eval.list/eval.stats", all(k in rjs for k in ["eval.create", "eval.list", "eval.stats"]))
check("[fe] 评价页前端零密钥（仅 callFunction）", "callFunction" in rjs and "cloud.init" not in rjs and "SECRET" not in rjs and "API_KEY" not in rjs)
kjs = read(os.path.join(MP, "pages", "knowledge", "knowledge.js"))
check("[fe] 知识库页调用 knowledge.list/create/update/delete/from_wo", all(k in kjs for k in ["knowledge.list", "knowledge.create", "knowledge.update", "knowledge.delete", "knowledge.from_wo"]))
kdjs = read(os.path.join(MP, "pages", "knowledge-detail", "knowledge-detail.js"))
check("[fe] 详情页调用 knowledge.detail", "knowledge.detail" in kdjs)
for p in ["web/review/index.html", "web/review/app.js", "web/review/style.css",
          "web/knowledge/index.html", "web/knowledge/app.js", "web/knowledge/style.css"]:
    check("[fe] Web 管理端文件存在 %s" % p, os.path.isfile(os.path.join(ROOT, p)))
wrev = read(os.path.join(ROOT, "web", "review", "app.js"))
check("[fe] Web 评价页调用 eval.stats/eval.list（管理视角）", "eval.stats" in wrev and "eval.list" in wrev)
wkn = read(os.path.join(ROOT, "web", "knowledge", "app.js"))
check("[fe] Web 知识库页调用 knowledge.list/create/update/delete/from_wo", all(k in wkn for k in ["knowledge.list", "knowledge.create", "knowledge.update", "knowledge.delete", "knowledge.from_wo"]))
check("[fe] Web 前端零密钥（不出现 SECRET/API_KEY 字面量）", "SECRET" not in wrev and "SECRET" not in wkn and "API_KEY" not in wrev and "API_KEY" not in wkn)

# ---------- 4. 文档同步 ----------
schema = read(os.path.join(DOCS, "schema.md"))
deploy = read(os.path.join(DOCS, "deploy.md"))
envt = read(os.path.join(DOCS, "env-template.md"))
check("[doc] schema.md 含 evaluations 集合", "### evaluations" in schema and "work_order_id" in schema)
check("[doc] schema.md 含 visit_plans 集合", "### visit_plans" in schema and "visit_date" in schema)
check("[doc] schema.md 含 knowledge_base 集合", "### knowledge_base" in schema and "两级可见性" in schema and "public" in schema and "internal" in schema)
check("[doc] schema.md 语言清单更新至 314 词条（阶段8 +58）", "314" in schema and "阶段8 新增 58 词条" in schema)
check("[doc] deploy.md 含阶段8部署步骤", "阶段 8 云函数" in deploy and "evaluation" in deploy and "knowledge" in deploy)
check("[doc] deploy.md 含 6.8 章节", "6.8" in deploy and "服务评价与知识库" in deploy)
check("[doc] deploy.md 上线清单含阶段8项", "阶段 8 云函数已部署" in deploy and "verify_stage8.py" in deploy)
check("[doc] env-template.md 含阶段8章节且注明无新增密钥", "阶段 8" in envt and "无新增密钥" in envt)

# ---------- 5. 16 语言包 ----------
langs = sorted(f[:-5] for f in os.listdir(LANG) if f.endswith(".json"))
check("[i18n] 语言包数量为 16", len(langs) == 16, "actual=%d" % len(langs))
if len(langs) == 16:
    keysets = {l: set(json.load(open(os.path.join(LANG, l + ".json"), encoding="utf-8")).keys()) for l in langs}
    basekeys = keysets[langs[0]]
    check("[i18n] 语言包 key 集合完全一致", all(ks == basekeys for ks in keysets.values()))
    s8keys = [k for k in basekeys if k.startswith("review") or k.startswith("evaluation") or k.startswith("knowledge") or k.startswith("kb")]
    check("[i18n] 阶段8新增词条齐全（review/evaluation/knowledge/kb ≥ 55）", len(s8keys) >= 55, "count=%d" % len(s8keys))
    sizes = {l: len(ks) for l, ks in keysets.items()}
    check("[i18n] 词条数一致（=314）", len(set(sizes.values())) == 1 and len(basekeys) == 314, json.dumps(sizes))

# ---------- 6. node 语法检查 + 单元测试（可选） ----------
if shutil.which("node"):
    for fn in FNS:
        r = subprocess.run(["node", "--check", os.path.join(CF, fn, "index.js")], capture_output=True, text=True, encoding="utf-8", errors="replace")
        check("[syntax] %s/index.js" % fn, r.returncode == 0, r.stderr[:300])
    for m in ["constants.js", "authGuard.js", "workflow.js", "response.js", "security.js", "rateLimit.js"]:
        p = os.path.join(COMMON, m)
        if os.path.isfile(p):
            r = subprocess.run(["node", "--check", p], capture_output=True, text=True, encoding="utf-8", errors="replace")
            check("[syntax] common/%s" % m, r.returncode == 0, r.stderr[:300])
    for m in ["review/review.js", "knowledge/knowledge.js", "knowledge-detail/knowledge-detail.js", "mine/mine.js"]:
        r = subprocess.run(["node", "--check", os.path.join(MP, "pages", m)], capture_output=True, text=True, encoding="utf-8", errors="replace")
        check("[syntax] pages/%s" % m, r.returncode == 0, r.stderr[:300])
    for m in ["web/review/app.js", "web/knowledge/app.js"]:
        r = subprocess.run(["node", "--check", os.path.join(ROOT, m)], capture_output=True, text=True, encoding="utf-8", errors="replace")
        check("[syntax] %s" % m, r.returncode == 0, r.stderr[:300])
    if os.path.isfile(os.path.join(SCRIPTS, "_stage8_unit_test.js")):
        r = subprocess.run(["node", os.path.join(SCRIPTS, "_stage8_unit_test.js")], capture_output=True, text=True, encoding="utf-8", errors="replace")
        out_path = os.path.join(SCRIPTS, "_stage8_unit_out.json")
        if r.returncode != 0 or not os.path.isfile(out_path):
            check("[ut] 阶段8单元测试运行", False, (r.stdout or "")[-300:] + (r.stderr or "")[-300:])
        else:
            res = json.load(open(out_path, encoding="utf-8"))
            check("[ut] 阶段8单元测试全部通过",
                  res.get("total") == res.get("passed"), "passed=%s/%s" % (res.get("passed"), res.get("total")))
            fails = [c.get("name") for c in res.get("checks", []) if not c.get("pass")]
            if fails:
                check("[ut] 无失败用例", False, " | ".join(fails))
else:
    print("[info] node 不可用，跳过语法检查与单测")

# ---------- 7. 安全红线回归 ----------
red = {"scan_secrets.py": "secrets", "validate_schema.py": "schema"}
for script, tag in red.items():
    sp = os.path.join(SCRIPTS, script)
    if os.path.isfile(sp):
        try:
            r = subprocess.run([sys.executable, sp], capture_output=True, text=True, cwd=SCRIPTS, timeout=240, encoding="utf-8", errors="replace")
            ok = r.returncode == 0
        except subprocess.TimeoutExpired:
            ok = False
        check("[redline] %s 通过" % script, ok, (r.stdout or "")[-400:] + (r.stderr or "")[-200:] if "r" in dir() else "timeout")
    else:
        check("[redline] %s 存在" % script, False)

print("=" * 72)
print("阶段8验收自检完成：%d/%d 通过" % (len(CHECKS) - len(FAILS), len(CHECKS)))
for name, ok, detail in CHECKS:
    print(("[PASS] " if ok else "[FAIL] ") + name + (("  | " + detail) if detail else ""))
if FAILS:
    print("\n失败项：")
    for f in FAILS:
        print(" -", f)
    sys.exit(1)
print("\nOK: 阶段8验收自检全部通过")

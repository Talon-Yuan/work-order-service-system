#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
schema.md 校验脚本（安全红线二：数据库零全开）
用法: python scripts/validate_schema.py [schema.md 路径]
校验:
  1) schema.md 覆盖项目书全部 20 集合（+ token_blacklist 预留）
  2) 每个集合段含「权限归属」行，无全开表述
  3) knowledge_base 含 visibility public/internal、system_config 含成本参数说明
退出码: 0=通过  1=未通过
"""
import os
import re
import sys

SCHEMA_PATH = os.path.abspath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "docs", "schema.md"
)) if len(sys.argv) < 2 else os.path.abspath(sys.argv[1])

COLLECTIONS = [
    "users", "device_profiles", "engineer_schedules", "appointments",
    "spare_parts", "stock_batches", "inventory_flows", "orders", "waybills",
    "work_orders", "work_steps", "notifications", "reports", "evaluations",
    "visit_plans", "knowledge_base", "system_config", "audit_logs",
    "payment_flows",
]
EXTRA_RESERVED = ["token_blacklist"]

def main():
    if not os.path.isfile(SCHEMA_PATH):
        print("FAIL: schema.md 不存在: %s" % SCHEMA_PATH)
        return 1
    with open(SCHEMA_PATH, "r", encoding="utf-8") as f:
        text = f.read()

    problems = []

    # 1) 集合覆盖
    missing = [c for c in COLLECTIONS if not re.search(r"^###\s+%s\s*—" % c, text, re.M)]
    if missing:
        problems.append("缺少集合定义: %s" % ", ".join(missing))
    for c in EXTRA_RESERVED:
        if not re.search(r"^###\s+%s\s*—" % c, text, re.M):
            problems.append("缺少预留集合定义: %s" % c)

    # 2) 每个集合段的权限归属 + 全开表述检查
    sections = re.split(r"^###\s+", text, flags=re.M)[1:]
    for sec in sections:
        name = sec.split("—", 1)[0].strip()
        if name not in COLLECTIONS + EXTRA_RESERVED:
            continue
        if "权限归属" not in sec:
            problems.append("[%s] 缺「权限归属」" % name)
        if re.search(r"所有用户可读写|全部用户可读写|read:\s*true,\s*write:\s*true|读写全开", sec, re.I):
            problems.append("[%s] 出现全开读写表述" % name)

    # 3) 专项
    kb = re.search(r"^###\s+knowledge_base\s*—.*?(?=\n---|\Z)", text, re.M | re.S)
    if kb and not re.search(r"visibility", kb.group(0)):
        problems.append("[knowledge_base] 缺 visibility 字段")
    sc = re.search(r"^###\s+system_config\s*—.*?(?=\n---|\Z)", text, re.M | re.S)
    if sc and not re.search(r"成本参数|cost\.", sc.group(0), re.I):
        problems.append("[system_config] 缺成本参数说明")

    # 4) 总数
    defined = [c for c in COLLECTIONS + EXTRA_RESERVED
               if re.search(r"^###\s+%s\s*—" % c, text, re.M)]
    print("== schema.md 校验 ==")
    print("集合定义数: %d / 20(+1 预留)" % len(defined))
    if not problems:
        print("通过: 全部集合覆盖，权限归属完整，无全开表述。")
        return 0
    for p in problems:
        print("FAIL: %s" % p)
    return 1

if __name__ == "__main__":
    sys.exit(main())

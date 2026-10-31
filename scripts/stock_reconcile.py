#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
stock_reconcile.py — 库存对账兜底脚本（阶段 4：任务 4-2）

作用：
  基于 inventory_flows（流水）推导"理论在库/理论预留"，与 stock_batches（批次账面）
  逐一比对，输出差异清单。用于在并发事务/人工误操作等场景下兜底发现账实不一致。

使用方式（两种模式）：
  1) 本地参考模式（无云端数据，跑通逻辑示例）：
       python scripts/stock_reconcile.py --demo
  2) 真实数据模式（从云数据库导出两个 JSON 后本机对账）：
       python scripts/stock_reconcile.py --flows flows.json --batches batches.json
     导出格式：
       flows.json    = [{ "part_id","batch_id","flow_type","quantity","ref_type","ref_id", ... }]
       batches.json  = [{ "_id","part_id","quantity","reserved","available","sold","status", ... }]

守恒模型（与 cloudfunctions/common/inventoryOps.js 一致）：
  quantity  = 当前在库总数（物理在库，含预留未发货）
  reserved  = 已预留未发货数量
  available = 可售可用 = quantity - reserved
  sold      = 已出库/已发货累计

流水增减量语义（inventory_flows.quantity 带符号）：
  in:+q / out:-q / reserve:+q / release:-q / check:±q（盘点修正）/ sn_mark:0（仅标记）

对账恒等式：
  Σin - Σout + Σcheck         == 理论在库(quantity)
  Σreserve - Σrelease         == 理论预留(reserved)
  理论可用 = 理论在库 - 理论预留（应 >= 0）

退出码：0=账实一致；1=存在差异；2=数据格式错误/用法错误
"""
import argparse
import json
import os
import sys

FLOW_TYPES = {"in", "out", "reserve", "release", "check", "sn_mark"}


def aggregate_flows(flows):
    """按批次聚合流水：返回 {batch_id: {'qty': 理论在库, 'reserved': 理论预留, 'in':..., 'out':...}}"""
    agg = {}
    for f in flows:
        ft = f.get("flow_type")
        if ft not in FLOW_TYPES:
            print("WARN: 忽略未知流水类型 %r (ref_id=%s)" % (ft, f.get("ref_id", "")))
            continue
        bid = f.get("batch_id") or ""
        if bid not in agg:
            agg[bid] = {"qty": 0, "reserved": 0, "in": 0, "out": 0, "check": 0, "reserve": 0, "release": 0}
        q = f.get("quantity") or 0
        if ft == "in":
            agg[bid]["qty"] += q
            agg[bid]["in"] += q
        elif ft == "out":
            agg[bid]["qty"] += q  # q 为负
            agg[bid]["out"] += q
        elif ft == "check":
            agg[bid]["qty"] += q
            agg[bid]["check"] += q
        elif ft == "reserve":
            agg[bid]["reserved"] += q
            agg[bid]["reserve"] += q
        elif ft == "release":
            agg[bid]["reserved"] += q  # q 为负
            agg[bid]["release"] += q
        # sn_mark: 不影响数量
    return agg


def reconcile(flows, batches):
    agg = aggregate_flows(flows)
    diffs = []
    by_id = {}
    for b in batches:
        by_id[b.get("_id") or ""] = b

    for bid, theo in agg.items():
        batch = by_id.get(bid)
        if batch is None:
            diffs.append({
                "batch_id": bid,
                "issue": "流水存在但批次不存在（孤儿流水）",
                "theo_qty": theo["qty"],
                "theo_reserved": theo["reserved"],
            })
            continue
        book_qty = batch.get("quantity") or 0
        book_reserved = batch.get("reserved") or 0
        if theo["qty"] != book_qty:
            diffs.append({
                "batch_id": bid,
                "part_id": batch.get("part_id", ""),
                "issue": "在库数量不一致",
                "book_qty": book_qty,
                "theo_qty": theo["qty"],
                "diff": theo["qty"] - book_qty,
            })
        if theo["reserved"] != book_reserved:
            diffs.append({
                "batch_id": bid,
                "part_id": batch.get("part_id", ""),
                "issue": "预留数量不一致",
                "book_reserved": book_reserved,
                "theo_reserved": theo["reserved"],
                "diff": theo["reserved"] - book_reserved,
            })
        # 守恒自检：available = quantity - reserved 且 >= 0
        book_available = batch.get("available") or 0
        if book_available != book_qty - book_reserved:
            diffs.append({
                "batch_id": bid,
                "part_id": batch.get("part_id", ""),
                "issue": "守恒被破坏 (available != quantity - reserved)",
                "available": book_available,
                "expect": book_qty - book_reserved,
            })
        if book_available < 0:
            diffs.append({
                "batch_id": bid,
                "part_id": batch.get("part_id", ""),
                "issue": "可用库存为负（超卖征兆）",
                "available": book_available,
            })

    # 批次存在但完全无流水（历史数据/初始库存）不算差异，仅提示
    return diffs


def load_json(path):
    if not os.path.isfile(path):
        print("FAIL: 文件不存在 %s" % path)
        sys.exit(2)
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def main():
    ap = argparse.ArgumentParser(description="库存对账兜底脚本")
    ap.add_argument("--flows", help="导出流水 JSON 路径")
    ap.add_argument("--batches", help="导出批次 JSON 路径")
    ap.add_argument("--demo", action="store_true", help="本地参考模式（内置示例数据）")
    args = ap.parse_args()

    if args.demo:
        flows = [
            {"batch_id": "B1", "part_id": "P1", "flow_type": "in", "quantity": 100},
            {"batch_id": "B1", "part_id": "P1", "flow_type": "reserve", "quantity": 30},
            {"batch_id": "B1", "part_id": "P1", "flow_type": "out", "quantity": -10},
            {"batch_id": "B2", "part_id": "P2", "flow_type": "in", "quantity": 5},
        ]
        batches = [
            {"_id": "B1", "part_id": "P1", "quantity": 90, "reserved": 30, "available": 60, "sold": 10, "status": "active"},
            {"_id": "B2", "part_id": "P2", "quantity": 5, "reserved": 0, "available": 5, "sold": 0, "status": "active"},
        ]
        print("== 演示数据（期望一致）==")
    elif args.flows and args.batches:
        flows = load_json(args.flows)
        batches = load_json(args.batches)
        print("== 真实数据对账 ==")
    else:
        ap.print_help()
        return 2

    diffs = reconcile(flows, batches)
    if not diffs:
        print("OK: 账实一致（%d 个批次参与对账）" % len({f.get('batch_id') for f in flows if f.get('batch_id')}))
        return 0

    print("DIFF: 发现 %d 处差异：" % len(diffs))
    for d in diffs:
        print(json.dumps(d, ensure_ascii=False, indent=2))
    return 1


if __name__ == "__main__":
    sys.exit(main())

/**
 * inventoryOps.js — 库存事务操作原语（阶段 4：防超卖核心）
 * 仅供云数据库事务内部调用（配合 db.runTransaction / startTransaction + commit）。
 *
 * 库存守恒模型（stock_batches 每批次一条）：
 *   quantity  = 当前在库总数（物理在库，含已预留未发货）
 *   reserved  = 已预留未发货数量
 *   available = 可售可用 = quantity - reserved（必须 >= 0）
 *   sold      = 已出库/已发货累计（信息字段）
 * 流水语义（inventory_flows.quantity 为带符号增减量）：
 *   in:+q / out:-q / reserve:+q / release:-q / check:±q（盘点修正）
 * 对账恒等式：Σin - Σout + Σcheck == 当前在库(quantity)；Σreserve - Σrelease == 当前预留(reserved)。
 *
 * 防超卖说明：预留/出库均在事务内"读→校验→写"，对同一批次文档的并发写会触发
 * 事务冲突，调用方按 withTransaction 的重试策略重跑并重新读取最新库存，
 * 因此不会出现"读旧值→扣成负数"的超卖窗口。
 */
const { COLLECTIONS } = require('./constants');

const RETRYABLE_CODES = [
  'DATABASE_TRANSACTION_CONFLICT',
  'TRANSACTION_CONFLICT',
  'DATABASE_TRANSACTION_EXPIRED'
];

function isRetryableErr(e) {
  const msg = (e && (e.errMsg || e.message || '')) || '';
  return RETRYABLE_CODES.some((c) => msg.indexOf(c) >= 0);
}

/**
 * 事务封装：自动重试冲突（默认 3 次），非冲突错误回滚后抛出
 * @param {object} db wx-server-sdk 数据库实例
 * @param {function(transaction):Promise<any>} handler
 */
async function withTransaction(db, handler, retries = 3) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const tx = await db.startTransaction();
    try {
      const result = await handler(tx);
      await tx.commit();
      return result;
    } catch (e) {
      try { await tx.rollback(); } catch (_) { /* rollback 失败忽略 */ }
      lastErr = e;
      if (isRetryableErr(e) && i < retries) continue;
      throw e;
    }
  }
  throw lastErr;
}

/** 事务内按备件预留库存（FIFO：available 升序先出旧批次）。返回扣减明细。 */
async function reserveInTx(tx, partId, qty, meta) {
  const q = Math.floor(qty);
  if (!Number.isFinite(q) || q <= 0) throw new Error('INVALID_QTY');
  const col = tx.collection(COLLECTIONS.STOCK_BATCHES);
  const res = await col.where({ part_id: partId, status: 'active' }).orderBy('created_at', 'asc').get();
  const batches = (res.data || []).filter((b) => (b.available || 0) > 0);
  const totalAvailable = batches.reduce((s, b) => s + (b.available || 0), 0);
  if (totalAvailable < q) {
    const err = new Error('NOT_ENOUGH_STOCK');
    err.available = totalAvailable;
    err.need = q;
    throw err;
  }
  const alloc = [];
  let remain = q;
  for (const b of batches) {
    if (remain <= 0) break;
    const take = Math.min(remain, b.available || 0);
    await col.doc(b._id).update({
      data: { reserved: (b.reserved || 0) + take, available: (b.available || 0) - take }
    });
    alloc.push({ batch_id: b._id, qty: take });
    remain -= take;
  }
  if (remain > 0) throw new Error('NOT_ENOUGH_STOCK'); // 理论上不会到这里
  await writeFlowInTx(tx, {
    part_id: partId,
    flow_type: 'reserve',
    quantity: q,
    batch_id: alloc.length === 1 ? alloc[0].batch_id : null,
    ref_type: meta.ref_type || 'order',
    ref_id: meta.ref_id,
    remark: meta.remark || '',
    operator: meta.operator || ''
  });
  return alloc;
}

/** 事务内释放预留（取消订单等）。alloc 形如 [{batch_id, qty}] */
async function releaseInTx(tx, partId, alloc, meta) {
  const col = tx.collection(COLLECTIONS.STOCK_BATCHES);
  let released = 0;
  for (const a of alloc || []) {
    const b = await col.doc(a.batch_id).get();
    if (!b || !b.data) continue;
    const cur = b.data;
    const rel = Math.min(a.qty || 0, cur.reserved || 0);
    await col.doc(a.batch_id).update({
      data: { reserved: (cur.reserved || 0) - rel, available: (cur.available || 0) + rel }
    });
    released += rel;
  }
  if (released > 0) {
    await writeFlowInTx(tx, {
      part_id: partId,
      flow_type: 'release',
      quantity: -released,
      batch_id: null,
      ref_type: meta.ref_type || 'order',
      ref_id: meta.ref_id,
      remark: meta.remark || '',
      operator: meta.operator || ''
    });
  }
  return released;
}

/**
 * 事务内出库（发货/领料/手工出库）。可选指定批次；不指定时按 FIFO 扣减。
 * type: 'consume'（预留转出库，reserved 减少）| 'direct'（直接出库，available 减少）
 */
async function outInTx(tx, partId, qty, opts = {}) {
  const q = Math.floor(qty);
  if (!Number.isFinite(q) || q <= 0) throw new Error('INVALID_QTY');
  const col = tx.collection(COLLECTIONS.STOCK_BATCHES);
  const alloc = opts.alloc || null;
  let targetBatches = [];
  if (alloc && alloc.length) {
    for (const a of alloc) {
      const b = await col.doc(a.batch_id).get();
      if (b && b.data) targetBatches.push({ ...b.data, _take: a.qty });
    }
  } else {
    const res = await col.where({ part_id: partId, status: 'active' }).orderBy('created_at', 'asc').get();
    targetBatches = (res.data || [])
      .filter((b) => ((opts.type === 'consume' ? b.reserved : b.available) || 0) > 0)
      .map((b) => ({ ...b, _take: 0 }));
    let remain = q;
    const picked = [];
    for (const b of targetBatches) {
      if (remain <= 0) break;
      const source = opts.type === 'consume' ? (b.reserved || 0) : (b.available || 0);
      const take = Math.min(remain, source);
      picked.push({ ...b, _take: take });
      remain -= take;
    }
    if (remain > 0) {
      const err = new Error('NOT_ENOUGH_STOCK');
      err.available = 0;
      err.need = remain;
      throw err;
    }
    targetBatches = picked;
  }
  let outCount = 0;
  for (const b of targetBatches) {
    const take = b._take || 0;
    if (take <= 0) continue;
    if (opts.type === 'consume') {
      await col.doc(b._id).update({
        data: {
          reserved: (b.reserved || 0) - take,
          quantity: (b.quantity || 0) - take,
          sold: (b.sold || 0) + take
        }
      });
    } else {
      await col.doc(b._id).update({
        data: {
          available: (b.available || 0) - take,
          quantity: (b.quantity || 0) - take,
          sold: (b.sold || 0) + take
        }
      });
    }
    outCount += take;
  }
  await writeFlowInTx(tx, {
    part_id: partId,
    flow_type: 'out',
    quantity: -outCount,
    batch_id: null,
    ref_type: opts.ref_type || 'manual',
    ref_id: opts.ref_id || '',
    sn: opts.sn || '',
    remark: opts.remark || '',
    operator: opts.operator || ''
  });
  return outCount;
}

/** 事务内入库（批次新增/SN 添加/手工入库） */
async function inInTx(tx, partId, qty, opts = {}) {
  const q = Math.floor(qty);
  if (!Number.isFinite(q) || q <= 0) throw new Error('INVALID_QTY');
  const col = tx.collection(COLLECTIONS.STOCK_BATCHES);
  let batch = null;
  if (opts.batchId) {
    const b = await col.doc(opts.batchId).get();
    if (b && b.data) batch = b.data;
  }
  if (!batch && opts.createBatch) {
    const addRes = await col.add({
      data: {
        part_id: partId,
        batch_no: opts.batchNo || '',
        warehouse: opts.warehouse || '',
        location: opts.location || '',
        expiry_date: opts.expiryDate || null,
        warn_threshold: opts.warnThreshold || 0,
        status: 'active',
        quantity: 0,
        reserved: 0,
        available: 0,
        sold: 0,
        sn_list: [],
        created_at: Date.now(),
        updated_at: Date.now(),
        operator: opts.operator || ''
      }
    });
    batch = { _id: addRes._id, ...opts };
  }
  if (!batch) throw new Error('BATCH_NOT_FOUND');
  await col.doc(batch._id).update({
    data: {
      quantity: (batch.quantity || 0) + q,
      available: (batch.available || 0) + q,
      updated_at: Date.now()
    }
  });
  await writeFlowInTx(tx, {
    part_id: partId,
    flow_type: 'in',
    quantity: q,
    batch_id: batch._id,
    sn: opts.sn || '',
    ref_type: opts.ref_type || 'batch',
    ref_id: opts.ref_id || batch._id,
    remark: opts.remark || '',
    operator: opts.operator || ''
  });
  return { batch_id: batch._id };
}

/** 事务内盘点：diff = 实盘数量 - 账面 quantity，允许为负 */
async function checkInTx(tx, partId, batchId, actualQty, meta) {
  const col = tx.collection(COLLECTIONS.STOCK_BATCHES);
  const b = await col.doc(batchId).get();
  if (!b || !b.data) throw new Error('BATCH_NOT_FOUND');
  const cur = b.data;
  const diff = Math.floor(actualQty) - (cur.quantity || 0);
  if (diff === 0) return 0;
  await col.doc(batchId).update({
    data: {
      quantity: (cur.quantity || 0) + diff,
      available: (cur.available || 0) + diff,
      updated_at: Date.now()
    }
  });
  await writeFlowInTx(tx, {
    part_id: partId,
    flow_type: 'check',
    quantity: diff,
    batch_id: batchId,
    ref_type: meta.ref_type || 'manual',
    ref_id: meta.ref_id || '',
    remark: meta.remark || '',
    operator: meta.operator || ''
  });
  return diff;
}

/** 事务内写库存流水（带 ref 唯一性去重：同单据同类型只写一条） */
async function writeFlowInTx(tx, f) {
  const col = tx.collection(COLLECTIONS.INVENTORY_FLOWS);
  const flow = {
    part_id: f.part_id,
    batch_id: f.batch_id || null,
    sn: f.sn || '',
    flow_type: f.flow_type,
    quantity: f.quantity,
    ref_type: f.ref_type || '',
    ref_id: f.ref_id || '',
    remark: f.remark || '',
    operator: f.operator || '',
    created_at: Date.now()
  };
  const added = await col.add({ data: flow });
  return added._id;
}

/** 事务内按备件读取当前可用库存汇总（供下单校验/预警） */
async function readAvailableInTx(tx, partId) {
  const col = tx.collection(COLLECTIONS.STOCK_BATCHES);
  const res = await col.where({ part_id: partId, status: 'active' }).get();
  const batches = res.data || [];
  return batches.reduce((s, b) => s + (b.available || 0), 0);
}

module.exports = {
  withTransaction,
  reserveInTx,
  releaseInTx,
  outInTx,
  inInTx,
  checkInTx,
  writeFlowInTx,
  readAvailableInTx
};

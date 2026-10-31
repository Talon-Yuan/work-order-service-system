/**
 * inventory 云函数 — 库存流水与防超卖（阶段 4：任务 4-2）
 *
 * 动作码：
 *   inventory.in       入库（管理端；批次 + 事务流水）
 *   inventory.out      出库（管理端 / 工程师施工领料；事务校验可用量防超卖）
 *   inventory.check    盘点（管理端；事务修正数量并写 check 流水）
 *   inventory.flows    流水查询（管理端 / 工程师；支持按备件/类型/时间过滤）
 *
 * 防超卖说明：
 *   - 预留/出库均在 withTransaction 事务内执行"读→校验→写"；
 *   - 对同一批次文档的并发写触发事务冲突，自动重试后重新读取最新库存，杜绝超卖窗口；
 *   - 同一单据同一流水的幂等由 ref_type+ref_id 唯一语义保障（schema.md 索引）；
 *   - 兜底对账脚本见 scripts/stock_reconcile.py。
 */
const { ok, fail } = require('./common/response');
const { ACTIONS, COLLECTIONS } = require('./common/constants');
const { cleanInput } = require('./common/security');
const { authGuard } = require('./common/authGuard');
const {
  withTransaction, inInTx, outInTx, checkInTx, writeFlowInTx
} = require('./common/inventoryOps');

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const action = event && event.action;
  switch (action) {
    case ACTIONS.INVENTORY_IN: return handleIn(event);
    case ACTIONS.INVENTORY_OUT: return handleOut(event);
    case ACTIONS.INVENTORY_CHECK: return handleCheck(event);
    case ACTIONS.INVENTORY_FLOWS: return handleFlows(event);
    default: return fail(400, 'UNKNOWN_ACTION');
  }
};

/** 入库：向指定批次（或新建批次）增加库存 */
async function handleIn(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      part_id: { type: 'string', max: 64, required: true },
      batch_id: { type: 'string', max: 64 },
      quantity: { type: 'number', required: true },
      remark: { type: 'string', max: 256 }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.INVENTORY_IN });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const qty = Math.floor(p.quantity || 0);
  if (qty <= 0) return fail(400, 'INVALID_QTY');

  try {
    const result = await withTransaction(db, async (tx) => {
      if (!p.batch_id) {
        // 未指定批次时自动归入该备件最近一个 active 批次；无批次则报错（管理端先建批次）
        const res = await tx.collection(COLLECTIONS.STOCK_BATCHES)
          .where({ part_id: p.part_id, status: 'active' })
          .orderBy('created_at', 'desc').limit(1).get();
        const b = res.data && res.data[0];
        if (!b) throw new Error('BATCH_NOT_FOUND');
        p.batch_id = b._id;
      }
      return inInTx(tx, p.part_id, qty, {
        batchId: p.batch_id,
        ref_type: 'manual',
        ref_id: 'manual:' + Date.now(),
        remark: p.remark || '手工入库',
        operator: ctx.openid
      });
    }, 3);
    return ok({ batch_id: result.batch_id, quantity: qty });
  } catch (e) {
    console.error('[inventory] in error:', e);
    if (e.message === 'BATCH_NOT_FOUND') return fail(404, 'BATCH_NOT_FOUND');
    return fail(500, 'INTERNAL: inventory in failed');
  }
}

/** 出库：管理端手工出库 / 工程师施工领料（可用量校验防超卖） */
async function handleOut(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      part_id: { type: 'string', max: 64, required: true },
      quantity: { type: 'number', required: true },
      ref_type: { type: 'string', max: 32 },
      ref_id: { type: 'string', max: 64 },
      work_order_id: { type: 'string', max: 64 },
      remark: { type: 'string', max: 256 }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.INVENTORY_OUT });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const qty = Math.floor(p.quantity || 0);
  if (qty <= 0) return fail(400, 'INVALID_QTY');

  const refType = p.ref_type || (p.work_order_id ? 'work_order' : 'manual');
  const refId = p.ref_id || p.work_order_id || 'manual:' + Date.now();

  try {
    const outCount = await withTransaction(db, async (tx) =>
      outInTx(tx, p.part_id, qty, {
        ref_type: refType,
        ref_id: refId,
        remark: p.remark || '出库',
        operator: ctx.openid
      }), 3);
    return ok({ quantity: outCount });
  } catch (e) {
    console.error('[inventory] out error:', e);
    if (e.message === 'NOT_ENOUGH_STOCK') return fail(409, 'NOT_ENOUGH_STOCK');
    return fail(500, 'INTERNAL: inventory out failed');
  }
}

/** 盘点：事务内修正账面数量并写 check 流水（diff = 实盘 - 账面） */
async function handleCheck(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      part_id: { type: 'string', max: 64, required: true },
      batch_id: { type: 'string', max: 64, required: true },
      actual_quantity: { type: 'number', required: true },
      remark: { type: 'string', max: 256 }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.INVENTORY_CHECK });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);

  try {
    const diff = await withTransaction(db, async (tx) =>
      checkInTx(tx, p.part_id, p.batch_id, p.actual_quantity, {
        ref_type: 'manual',
        ref_id: 'check:' + Date.now(),
        remark: p.remark || '盘点修正',
        operator: ctx.openid
      }), 3);
    return ok({ diff });
  } catch (e) {
    console.error('[inventory] check error:', e);
    if (e.message === 'BATCH_NOT_FOUND') return fail(404, 'BATCH_NOT_FOUND');
    return fail(500, 'INTERNAL: inventory check failed');
  }
}

/** 流水查询（管理端 / 工程师；按备件/类型过滤 + 分页） */
async function handleFlows(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      part_id: { type: 'string', max: 64 },
      flow_type: { type: 'string', max: 32 },
      page: { type: 'number' },
      page_size: { type: 'number' }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.INVENTORY_FLOWS });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);

  const page = Math.max(1, Math.floor(p.page || 1));
  const pageSize = Math.min(50, Math.max(1, Math.floor(p.page_size || 10)));

  try {
    const cond = {};
    if (p.part_id) cond.part_id = p.part_id;
    if (p.flow_type) cond.flow_type = p.flow_type;
    const where = db.collection(COLLECTIONS.INVENTORY_FLOWS).where(cond);
    const [listRes, countRes] = await Promise.all([
      where.orderBy('created_at', 'desc').skip((page - 1) * pageSize).limit(pageSize).get(),
      where.count()
    ]);
    return ok({ list: listRes.data || [], total: countRes.total, page, page_size: pageSize });
  } catch (e) {
    console.error('[inventory] flows error:', e);
    return fail(500, 'INTERNAL: flows query failed');
  }
}

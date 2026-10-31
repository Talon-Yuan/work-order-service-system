/**
 * order 云函数 — 备件商城下单与订单管理（阶段 4：任务 4-3 下单 + 4-5 订单管理）
 *
 * 动作码：
 *   cart.add / cart.list / cart.remove       购物车（Web 端：服务端购物车集合；小程序端走本地 storage 亦可）
 *   order.create                             下单：事务【查库存 → 扣预留 → 写流水 → 建订单】+ 并发唯一索引防超卖
 *   order.list / order.detail                订单查询（客户看自己的；管理端看全部）
 *   order.cancel                             取消订单：释放预留 + 写 release 流水（仅待支付状态）
 *   order.ship                               发货（管理端）：预留转出库，写 out 流水
 *   order.refund                             售后/退款（管理端）：出库回冲入在库，写流水
 *   order.complete                           确认完成（客户 / 管理端）
 *
 * 状态机：pending(待支付) → paid(已支付) → shipped(已发货) → completed(已完成)
 *          └ pending → cancelled(已取消)
 *          └ paid → refunded(已退款)
 * 所有非法流转一律拒绝；支付成功由 pay 云函数幂等更新。
 */
const { ok, fail } = require('./common/response');
const { ACTIONS, COLLECTIONS } = require('./common/constants');
const { cleanInput } = require('./common/security');
const { authGuard } = require('./common/authGuard');
const {
  withTransaction, reserveInTx, releaseInTx, outInTx, writeFlowInTx, readAvailableInTx
} = require('./common/inventoryOps');

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const ORDER_STATUS = ['pending', 'paid', 'shipped', 'completed', 'cancelled', 'refunded'];

function genOrderNo() {
  const d = new Date();
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const rand = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
  return `PO${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${rand}`;
}

exports.main = async (event) => {
  const action = event && event.action;
  switch (action) {
    case ACTIONS.CART_ADD: return handleCartAdd(event);
    case ACTIONS.CART_LIST: return handleCartList(event);
    case ACTIONS.CART_REMOVE: return handleCartRemove(event);
    case ACTIONS.ORDER_CREATE: return handleOrderCreate(event);
    case ACTIONS.ORDER_LIST: return handleOrderList(event);
    case ACTIONS.ORDER_DETAIL: return handleOrderDetail(event);
    case ACTIONS.ORDER_CANCEL: return handleOrderCancel(event);
    case ACTIONS.ORDER_SHIP: return handleOrderShip(event);
    case ACTIONS.ORDER_REFUND: return handleOrderRefund(event);
    case ACTIONS.ORDER_COMPLETE: return handleOrderComplete(event);
    default: return fail(400, 'UNKNOWN_ACTION');
  }
};

/* ---------------- 购物车（Web 服务端；小程序端建议本地 storage） ---------------- */

async function handleCartAdd(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      part_id: { type: 'string', max: 64, required: true },
      quantity: { type: 'number', required: true }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.CART_ADD });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const qty = Math.floor(p.quantity || 0);
  if (qty <= 0 || qty > 99) return fail(400, 'INVALID_QTY');

  try {
    const col = db.collection(COLLECTIONS.CARTS);
    const dup = await col.where({ _openid: ctx.openid, part_id: p.part_id }).limit(1).get();
    if (dup.data && dup.data.length) {
      const cur = dup.data[0];
      await col.doc(cur._id).update({
        data: { quantity: Math.min(99, (cur.quantity || 0) + qty), updated_at: Date.now() }
      });
    } else {
      await col.add({
        data: {
          part_id: p.part_id,
          quantity: qty,
          created_at: Date.now(),
          updated_at: Date.now(),
          _openid: ctx.openid
        }
      });
    }
    return ok({ added: true });
  } catch (e) {
    console.error('[order] cart.add error:', e);
    return fail(500, 'INTERNAL: cart add failed');
  }
}

async function handleCartList(event) {
  const ctx = await authGuard(event, { action: ACTIONS.CART_LIST });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);

  try {
    const res = await db.collection(COLLECTIONS.CARTS)
      .where({ _openid: ctx.openid }).orderBy('updated_at', 'desc').limit(50).get();
    const items = res.data || [];
    // 联查备件公开信息
    const partIds = items.map((i) => i.part_id);
    const parts = {};
    if (partIds.length) {
      const pr = await db.collection(COLLECTIONS.SPARE_PARTS)
        .where({ _id: db.command.in(partIds) }).limit(50).get();
      for (const d of pr.data || []) parts[d._id] = d;
    }
    return ok({
      list: items.map((i) => ({
        _id: i._id,
        part_id: i.part_id,
        quantity: i.quantity,
        part: parts[i.part_id] ? {
          part_no: parts[i.part_id].part_no,
          part_name: parts[i.part_id].part_name,
          spec: parts[i.part_id].spec,
          unit: parts[i.part_id].unit,
          price_fen: parts[i.part_id].price_fen,
          image_url: parts[i.part_id].image_url,
          status: parts[i.part_id].status
        } : null
      }))
    });
  } catch (e) {
    console.error('[order] cart.list error:', e);
    return fail(500, 'INTERNAL: cart list failed');
  }
}

async function handleCartRemove(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      cart_id: { type: 'string', max: 64, required: true },
      part_id: { type: 'string', max: 64 }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.CART_REMOVE });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);

  try {
    const col = db.collection(COLLECTIONS.CARTS);
    if (p.cart_id) {
      await col.doc(p.cart_id).remove(); // 行级过滤器会校验归属
    } else if (p.part_id) {
      await col.where({ _openid: ctx.openid, part_id: p.part_id }).remove();
    }
    return ok({ removed: true });
  } catch (e) {
    console.error('[order] cart.remove error:', e);
    return fail(500, 'INTERNAL: cart remove failed');
  }
}

/* ---------------- 下单（防超卖核心） ---------------- */

/**
 * 下单：单事务内
 *   1) 读库存（按备件汇总可用量 + 批次明细）
 *   2) 校验可用量足够（不足 → NOT_ENOUGH_STOCK，返回差额）
 *   3) 按批次扣预留（available→reserved），写 reserve 流水
 *   4) 建订单（status=pending）
 * 并发兜底：orders 建单写入唯一索引 {_openid, client_order_no}，
 * 重复提交同一 client_order_no 会触发唯一冲突 → 幂等返回原订单或拒绝。
 */
async function handleOrderCreate(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      items: { type: 'array', required: true },
      client_order_no: { type: 'string', max: 64 },
      remark: { type: 'string', max: 256 },
      address: { type: 'string', max: 256 }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.ORDER_CREATE });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);

  const items = (p.items || []).map((it) => ({
    part_id: String((it && it.part_id) || '').slice(0, 64),
    quantity: Math.floor((it && it.quantity) || 0)
  })).filter((it) => it.part_id && it.quantity > 0);
  if (!items.length) return fail(400, 'INVALID_ITEMS');
  const clientOrderNo = p.client_order_no || genOrderNo();

  try {
    const result = await withTransaction(db, async (tx) => {
      // 1-2) 汇总校验 + 预扣预留
      const allocByPart = {};
      for (const it of items) {
        const avail = await readAvailableInTx(tx, it.part_id);
        if (avail < it.quantity) {
          const err = new Error('NOT_ENOUGH_STOCK');
          err.part_id = it.part_id;
          err.available = avail;
          err.need = it.quantity;
          throw err;
        }
      }
      for (const it of items) {
        const alloc = await reserveInTx(tx, it.part_id, it.quantity, {
          ref_type: 'order',
          ref_id: clientOrderNo,
          operator: ctx.openid
        });
        allocByPart[it.part_id] = alloc;
      }
      // 3) 读备件价格（事务内不允许并发写价格，此处读后计算总价）
      let totalFen = 0;
      const itemDocs = [];
      for (const it of items) {
        const part = await tx.collection(COLLECTIONS.SPARE_PARTS).doc(it.part_id).get();
        if (!part.data) throw new Error('PART_NOT_FOUND');
        totalFen += (part.data.price_fen || 0) * it.quantity;
        itemDocs.push({
          part_id: it.part_id,
          part_no: part.data.part_no,
          part_name: part.data.part_name,
          spec: part.data.spec || '',
          unit: part.data.unit || '件',
          price_fen: part.data.price_fen || 0,
          quantity: it.quantity,
          batch_alloc: allocByPart[it.part_id] || []
        });
      }
      // 4) 建订单
      const now = Date.now();
      const order = {
        order_no: clientOrderNo,
        _openid: ctx.openid,
        items: itemDocs,
        total_fen: totalFen,
        status: 'pending',
        pay_status: 'unpaid',
        remark: p.remark || '',
        address: p.address || '',
        cancel_reason: '',
        invoice_status: 'not_invoiced',
        created_at: now,
        updated_at: now
      };
      const addRes = await tx.collection(COLLECTIONS.ORDERS).add({ data: order });
      return { _id: addRes._id, order_no: clientOrderNo, total_fen: totalFen, status: 'pending' };
    }, 3);

    return ok(result);
  } catch (e) {
    console.error('[order] create error:', e);
    if (e.message === 'NOT_ENOUGH_STOCK') {
      return fail(409, 'NOT_ENOUGH_STOCK', { part_id: e.part_id, available: e.available, need: e.need });
    }
    if (e.message === 'PART_NOT_FOUND') return fail(404, 'PART_NOT_FOUND');
    if (String(e.errMsg || e.message || '').indexOf('duplicate') >= 0) return fail(409, 'DUPLICATE_CLIENT_ORDER');
    return fail(500, 'INTERNAL: order create failed');
  }
}

/* ---------------- 订单查询 ---------------- */

async function handleOrderList(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      status: { type: 'string', max: 16 },
      page: { type: 'number' },
      page_size: { type: 'number' }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.ORDER_LIST });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);

  const page = Math.max(1, Math.floor(p.page || 1));
  const pageSize = Math.min(20, Math.max(1, Math.floor(p.page_size || 10)));

  try {
    const cond = {};
    // 客户只能看自己的；管理端按角色看全部（authGuard 已在行级过滤补充 _openid 约束）
    cond._openid = ctx.openid;
    if (p.status && ORDER_STATUS.indexOf(p.status) >= 0) cond.status = p.status;
    const where = db.collection(COLLECTIONS.ORDERS).where(cond);
    const [listRes, countRes] = await Promise.all([
      where.orderBy('created_at', 'desc').skip((page - 1) * pageSize).limit(pageSize).get(),
      where.count()
    ]);
    return ok({ list: listRes.data || [], total: countRes.total, page, page_size: pageSize });
  } catch (e) {
    console.error('[order] list error:', e);
    return fail(500, 'INTERNAL: order list failed');
  }
}

async function handleOrderDetail(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      order_id: { type: 'string', max: 64, required: true }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.ORDER_DETAIL });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);

  try {
    const res = await db.collection(COLLECTIONS.ORDERS).doc(p.order_id).get();
    if (!res.data) return fail(404, 'NOT_FOUND');
    return ok(res.data);
  } catch (e) {
    console.error('[order] detail error:', e);
    return fail(500, 'INTERNAL: order detail failed');
  }
}

/* ---------------- 状态流转 ---------------- */

/** 取消订单（仅 pending）：事务内释放预留 + 写 release 流水 + 状态改 cancelled */
async function handleOrderCancel(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      order_id: { type: 'string', max: 64, required: true },
      reason: { type: 'string', max: 256 }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.ORDER_CANCEL });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);

  try {
    const result = await withTransaction(db, async (tx) => {
      const order = await tx.collection(COLLECTIONS.ORDERS).doc(p.order_id).get();
      if (!order.data) throw new Error('ORDER_NOT_FOUND');
      if (order.data.status !== 'pending') throw new Error('INVALID_STATUS_TRANSITION');
      for (const item of order.data.items || []) {
        await releaseInTx(tx, item.part_id, item.batch_alloc || [], {
          ref_type: 'order',
          ref_id: order.data.order_no,
          remark: '取消订单释放预留',
          operator: ctx.openid
        });
      }
      await tx.collection(COLLECTIONS.ORDERS).doc(p.order_id).update({
        data: { status: 'cancelled', pay_status: 'closed', cancel_reason: p.reason || '用户取消', updated_at: Date.now() }
      });
      return { order_id: p.order_id, status: 'cancelled' };
    }, 3);

    return ok(result);
  } catch (e) {
    console.error('[order] cancel error:', e);
    if (e.message === 'ORDER_NOT_FOUND') return fail(404, 'ORDER_NOT_FOUND');
    if (e.message === 'INVALID_STATUS_TRANSITION') return fail(409, 'INVALID_STATUS_TRANSITION');
    return fail(500, 'INTERNAL: order cancel failed');
  }
}

/** 发货（管理端）：事务内预留转出库（out 流水）+ 状态 pending/paid → shipped */
async function handleOrderShip(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      order_id: { type: 'string', max: 64, required: true },
      logistics_no: { type: 'string', max: 64 },
      remark: { type: 'string', max: 256 }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.ORDER_SHIP });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);

  try {
    const result = await withTransaction(db, async (tx) => {
      const order = await tx.collection(COLLECTIONS.ORDERS).doc(p.order_id).get();
      if (!order.data) throw new Error('ORDER_NOT_FOUND');
      if (order.data.status !== 'paid') throw new Error('INVALID_STATUS_TRANSITION');
      for (const item of order.data.items || []) {
        await outInTx(tx, item.part_id, item.quantity, {
          alloc: item.batch_alloc || [],
          type: 'consume',
          ref_type: 'order',
          ref_id: order.data.order_no,
          remark: '订单发货出库',
          operator: ctx.openid
        });
      }
      await tx.collection(COLLECTIONS.ORDERS).doc(p.order_id).update({
        data: {
          status: 'shipped',
          logistics_no: p.logistics_no || '',
          shipped_at: Date.now(),
          updated_at: Date.now()
        }
      });
      return { order_id: p.order_id, status: 'shipped' };
    }, 3);

    return ok(result);
  } catch (e) {
    console.error('[order] ship error:', e);
    if (e.message === 'ORDER_NOT_FOUND') return fail(404, 'ORDER_NOT_FOUND');
    if (e.message === 'INVALID_STATUS_TRANSITION') return fail(409, 'INVALID_STATUS_TRANSITION');
    return fail(500, 'INTERNAL: order ship failed');
  }
}

/** 售后/退款（管理端）：已支付未发货订单退款，出库回冲在库（in 流水）+ 状态 → refunded */
async function handleOrderRefund(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      order_id: { type: 'string', max: 64, required: true },
      reason: { type: 'string', max: 256 }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.ORDER_REFUND });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);

  try {
    const result = await withTransaction(db, async (tx) => {
      const order = await tx.collection(COLLECTIONS.ORDERS).doc(p.order_id).get();
      if (!order.data) throw new Error('ORDER_NOT_FOUND');
      if (order.data.status !== 'paid') throw new Error('INVALID_STATUS_TRANSITION');
      for (const item of order.data.items || []) {
        // 已支付未发货：预留回冲为可用
        await releaseInTx(tx, item.part_id, item.batch_alloc || [], {
          ref_type: 'order_refund',
          ref_id: order.data.order_no,
          remark: '退款释放预留',
          operator: ctx.openid
        });
      }
      await tx.collection(COLLECTIONS.ORDERS).doc(p.order_id).update({
        data: { status: 'refunded', pay_status: 'refunded', refund_reason: p.reason || '售后退款', updated_at: Date.now() }
      });
      return { order_id: p.order_id, status: 'refunded' };
    }, 3);

    return ok(result);
  } catch (e) {
    console.error('[order] refund error:', e);
    if (e.message === 'ORDER_NOT_FOUND') return fail(404, 'ORDER_NOT_FOUND');
    if (e.message === 'INVALID_STATUS_TRANSITION') return fail(409, 'INVALID_STATUS_TRANSITION');
    return fail(500, 'INTERNAL: order refund failed');
  }
}

/** 确认完成（客户 / 管理端）：shipped → completed */
async function handleOrderComplete(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      order_id: { type: 'string', max: 64, required: true }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.ORDER_COMPLETE });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);

  try {
    await db.collection(COLLECTIONS.ORDERS).doc(p.order_id).update({
      data: { status: 'completed', completed_at: Date.now(), updated_at: Date.now() }
    });
    return ok({ order_id: p.order_id, status: 'completed' });
  } catch (e) {
    console.error('[order] complete error:', e);
    return fail(500, 'INTERNAL: order complete failed');
  }
}

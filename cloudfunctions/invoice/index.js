/**
 * invoice 云函数 — 发票登记与通知（阶段 4：任务 4-5）
 *
 * 动作码：
 *   invoice.request   客户发起开票请求（订单已支付）→ 状态 pending → invoice_requested，通知管理员
 *   invoice.issue     管理员登记开票（发票号/抬头/金额/PDF）→ invoice_requested → invoiced，通知客户
 *   invoice.list      发票查询（客户看自己的；管理端看全部）
 *   invoice.info      发票详情（含订单/开票信息）
 *
 * 发票状态机：not_invoiced(未开票) → invoice_requested(待开票) → invoiced(已开票)
 * 非法流转拒绝（如未支付订单不可申请、未申请不可登记开票）。
 *
 * 通知：写入 notifications 集合（定向 _openid / role），前端消息中心展示；
 * 真实短信/微信订阅消息推送在 deploy.md 中说明接入点，不在本骨架伪造凭据。
 */
const { ok, fail } = require('./common/response');
const { ACTIONS, COLLECTIONS } = require('./common/constants');
const { cleanInput } = require('./common/security');
const { authGuard } = require('./common/authGuard');
const { withTransaction } = require('./common/inventoryOps');

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const INVOICE_STATUS = ['not_invoiced', 'invoice_requested', 'invoiced'];

exports.main = async (event) => {
  const action = event && event.action;
  switch (action) {
    case ACTIONS.INVOICE_REQUEST: return handleRequest(event);
    case ACTIONS.INVOICE_ISSUE: return handleIssue(event);
    case ACTIONS.INVOICE_LIST: return handleList(event);
    case ACTIONS.INVOICE_INFO: return handleInfo(event);
    default: return fail(400, 'UNKNOWN_ACTION');
  }
};

async function addNotification({ to_openid, to_role, title, content, ref_type, ref_id }) {
  await db.collection(COLLECTIONS.NOTIFICATIONS).add({
    data: {
      receiver_openid: to_openid || '',
      to_role: to_role || '',
      type: 'order',
      title,
      content,
      ref_type: ref_type || '',
      ref_id: ref_id || '',
      is_read: false,
      created_at: Date.now()
    }
  });
}

/** 客户发起开票请求（订单已支付且未开票） */
async function handleRequest(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      order_id: { type: 'string', max: 64, required: true },
      invoice_title: { type: 'string', max: 128 },
      invoice_tax_no: { type: 'string', max: 64 },
      invoice_email: { type: 'string', max: 128 },
      remark: { type: 'string', max: 256 }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.INVOICE_REQUEST });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);

  try {
    const result = await withTransaction(db, async (tx) => {
      const order = await tx.collection(COLLECTIONS.ORDERS).doc(p.order_id).get();
      if (!order.data) throw new Error('ORDER_NOT_FOUND');
      if (order.data._openid !== ctx.openid) throw new Error('FORBIDDEN');
      if (order.data.status !== 'paid') throw new Error('ORDER_NOT_PAID');
      const curStatus = order.data.invoice_status || 'not_invoiced';
      if (curStatus === 'invoiced') throw new Error('ALREADY_INVOICED');
      await tx.collection(COLLECTIONS.ORDERS).doc(p.order_id).update({
        data: {
          invoice_status: 'invoice_requested',
          invoice_title: p.invoice_title || '',
          invoice_tax_no: p.invoice_tax_no || '',
          invoice_email: p.invoice_email || '',
          invoice_requested_at: Date.now(),
          updated_at: Date.now()
        }
      });
      return { order_id: p.order_id };
    }, 3);

    // 通知管理员（事务外追加通知，失败不影响主流程）
    try {
      await addNotification({
        to_role: 'admin', title: '客户申请开票',
        content: `订单 ${p.order_id} 申请开票，请登记发票信息`,
        ref_type: 'order', ref_id: p.order_id
      });
    } catch (e) { console.warn('[invoice] notify admin failed', e); }

    return ok(result);
  } catch (e) {
    console.error('[invoice] request error:', e);
    if (e.message === 'ORDER_NOT_FOUND') return fail(404, 'ORDER_NOT_FOUND');
    if (e.message === 'FORBIDDEN') return fail(403, 'FORBIDDEN');
    if (e.message === 'ORDER_NOT_PAID') return fail(409, 'ORDER_NOT_PAID');
    if (e.message === 'ALREADY_INVOICED') return fail(409, 'ALREADY_INVOICED');
    return fail(500, 'INTERNAL: invoice request failed');
  }
}

/** 管理员登记开票（必须先有客户申请；登记后通知客户） */
async function handleIssue(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      order_id: { type: 'string', max: 64, required: true },
      invoice_no: { type: 'string', max: 64, required: true },
      invoice_type: { type: 'string', max: 16 },
      invoice_amount_fen: { type: 'number' },
      invoice_pdf_url: { type: 'string', max: 512 },
      remark: { type: 'string', max: 256 }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.INVOICE_ISSUE });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);

  try {
    const result = await withTransaction(db, async (tx) => {
      const order = await tx.collection(COLLECTIONS.ORDERS).doc(p.order_id).get();
      if (!order.data) throw new Error('ORDER_NOT_FOUND');
      const curStatus = order.data.invoice_status || 'not_invoiced';
      if (curStatus !== 'invoice_requested') throw new Error('INVALID_INVOICE_TRANSITION');
      await tx.collection(COLLECTIONS.ORDERS).doc(p.order_id).update({
        data: {
          invoice_status: 'invoiced',
          invoice_no: p.invoice_no,
          invoice_type: p.invoice_type || '电子普通发票',
          invoice_amount_fen: p.invoice_amount_fen !== undefined
            ? Math.max(0, Math.floor(p.invoice_amount_fen)) : order.data.total_fen,
          invoice_pdf_url: p.invoice_pdf_url || '',
          invoice_issued_at: Date.now(),
          updated_at: Date.now()
        }
      });
      return { order_id: p.order_id, invoice_no: p.invoice_no, _openid: order.data._openid };
    }, 3);

    // 通知客户
    try {
      await addNotification({
        to_openid: result._openid, title: '发票已开具',
        content: `订单 ${p.order_id} 已开具发票（发票号 ${p.invoice_no}），请查收`,
        ref_type: 'order', ref_id: p.order_id
      });
    } catch (e) { console.warn('[invoice] notify customer failed', e); }

    return ok(result);
  } catch (e) {
    console.error('[invoice] issue error:', e);
    if (e.message === 'ORDER_NOT_FOUND') return fail(404, 'ORDER_NOT_FOUND');
    if (e.message === 'INVALID_INVOICE_TRANSITION') return fail(409, 'INVALID_INVOICE_TRANSITION');
    return fail(500, 'INTERNAL: invoice issue failed');
  }
}

/** 发票列表：客户看自己的，管理端看全部 */
async function handleList(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      status: { type: 'string', max: 32 },
      page: { type: 'number' },
      page_size: { type: 'number' }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.INVOICE_LIST });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);

  const page = Math.max(1, Math.floor(p.page || 1));
  const pageSize = Math.min(20, Math.max(1, Math.floor(p.page_size || 10)));

  try {
    const cond = {};
    if (p.status && INVOICE_STATUS.indexOf(p.status) >= 0) cond.invoice_status = p.status;
    // 客户只能看自己的订单发票（authGuard 行级过滤已并入）
    cond._openid = ctx.openid;
    const where = db.collection(COLLECTIONS.ORDERS).where(cond);
    const [listRes, countRes] = await Promise.all([
      where.orderBy('created_at', 'desc').skip((page - 1) * pageSize).limit(pageSize).get(),
      where.count()
    ]);
    const list = (listRes.data || []).map((d) => ({
      order_id: d._id,
      order_no: d.order_no,
      status: d.invoice_status || 'not_invoiced',
      invoice_no: d.invoice_no || '',
      invoice_type: d.invoice_type || '',
      invoice_amount_fen: d.invoice_amount_fen,
      invoice_title: d.invoice_title || '',
      total_fen: d.total_fen,
      invoice_issued_at: d.invoice_issued_at || null,
      created_at: d.created_at
    }));
    return ok({ list, total: countRes.total, page, page_size: pageSize });
  } catch (e) {
    console.error('[invoice] list error:', e);
    return fail(500, 'INTERNAL: invoice list failed');
  }
}

/** 发票详情 */
async function handleInfo(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      order_id: { type: 'string', max: 64, required: true }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.INVOICE_INFO });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);

  try {
    const res = await db.collection(COLLECTIONS.ORDERS).doc(p.order_id).get();
    if (!res.data) return fail(404, 'NOT_FOUND');
    const d = res.data;
    return ok({
      order_id: d._id,
      order_no: d.order_no,
      status: d.invoice_status || 'not_invoiced',
      invoice_title: d.invoice_title || '',
      invoice_tax_no: d.invoice_tax_no || '',
      invoice_email: d.invoice_email || '',
      invoice_no: d.invoice_no || '',
      invoice_type: d.invoice_type || '',
      invoice_amount_fen: d.invoice_amount_fen,
      invoice_pdf_url: d.invoice_pdf_url || '',
      invoice_requested_at: d.invoice_requested_at || null,
      invoice_issued_at: d.invoice_issued_at || null,
      remark: d.invoice_remark || ''
    });
  } catch (e) {
    console.error('[invoice] info error:', e);
    return fail(500, 'INTERNAL: invoice info failed');
  }
}

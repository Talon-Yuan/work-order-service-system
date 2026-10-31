/**
 * accept 云函数 — 任务 5-3a：客户电子签名验收 / 驳回
 * 安全要点：
 *  - 只允许工单关联客户本人验收/驳回（customer_openid === authGuard.openid），
 *    非关联客户无法验收他人工单（防水平越权验收）；
 *  - 状态必须为 pending_acceptance（待验收），其他状态拒绝；
 *  - 签名图片 fileID 必须来自本客户上传（upload_logs 归属校验），禁传他人图片；
 *  - 验收/驳回均写 audit_logs + 站内通知（工程师/负责人）。
 */
const { ok, fail } = require('./common/response');
const { ACTIONS, COLLECTIONS, WO_STATUS } = require('./common/constants');
const { cleanInput } = require('./common/security');
const { authGuard } = require('./common/authGuard');
const { writeAudit, sendNotification, assertTransition } = require('./common/workflow');

exports.main = async (event) => {
  const action = event && event.action;
  if (action === 'wo.accept') return acceptWorkOrder(event);
  if (action === 'wo.reject') return rejectWorkOrder(event);
  return fail(400, 'UNKNOWN_ACTION');
};

/** 校验：操作者必须是工单关联客户本人 */
function assertOwner(wo, openid) {
  if (!wo || wo.customer_openid !== openid) {
    return { ok: false, code: 403, msg: 'NOT_WO_OWNER' };
  }
  return { ok: true };
}

async function acceptWorkOrder(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      work_order_id: { type: 'string', max: 64, required: true },
      signature_file_id: { type: 'string', max: 200, required: true }, // 电子签名图片 fileID（本客户上传）
      result: { type: 'string', max: 500, default: '' },               // 验收意见
      rating: { type: 'number', min: 1, max: 5, default: 5 }           // 服务评分（1-5）
    });
  } catch (e) {
    return fail(400, 'INVALID_PARAMS');
  }
  const ctx = await authGuard(event, { action: ACTIONS.WO_ACCEPT });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db, openid, role } = ctx;

  try {
    // 行级过滤 + 指定 id：客户仅能读到自己的工单
    const woRes = await db.collection(COLLECTIONS.WORK_ORDERS)
      .where(Object.assign({}, ctx.rowFilter, { _id: p.work_order_id })).limit(1).get();
    if (!woRes.data.length) return fail(404, 'WORK_ORDER_NOT_FOUND');
    const wo = woRes.data[0];

    // ① 越权验收拒绝：必须工单关联客户本人
    const own = assertOwner(wo, openid);
    if (!own.ok) return fail(own.code, own.msg);

    // ② 状态机校验：待验收 → 已验收
    try {
      assertTransition(wo.status, WO_STATUS.ACCEPTED);
    } catch (e) {
      return fail(409, 'INVALID_TRANSITION');
    }

    // ③ 签名图片归属校验：fileID 必须在本客户 upload_logs 中（防止引用他人文件）
    const sigRes = await db.collection(COLLECTIONS.UPLOAD_LOGS)
      .where({ file_id: p.signature_file_id, uploader_openid: openid }).limit(1).get();
    if (!sigRes.data.length) return fail(403, 'SIGNATURE_FILE_NOT_YOURS');

    const now = new Date();
    await db.collection(COLLECTIONS.WORK_ORDERS).doc(wo._id).update({
      data: {
        status: WO_STATUS.ACCEPTED,
        acceptance: {
          type: 'accepted',
          customer_openid: openid,
          signature_file_id: p.signature_file_id,
          result: p.result || '',
          rating: Math.max(1, Math.min(5, Number(p.rating) || 5)), // 评分夹取 1-5
          accepted_at: now
        },
        need_evaluation: true,   // 阶段5：验收后触发评价邀请
        updated_at: now
      }
    });

    await writeAudit(db, {
      actor_openid: openid, role,
      action: 'accept', target_collection: COLLECTIONS.WORK_ORDERS, target_id: wo._id,
      before: { status: wo.status },
      after: { status: WO_STATUS.ACCEPTED, rating: p.rating }
    });

    // 通知：工程师/负责人 验收通过，可闭环
    const receivers = [wo.engineer_openid, wo.owner_openid].filter((x) => x && x !== openid);
    await Promise.all(receivers.map((r) =>
      sendNotification(db, {
        receiver_openid: r, type: 'work_order',
        title: '工单已验收', content: '工单 ' + wo.work_order_no + ' 已被客户验收通过，可生成服务报告并闭环。',
        ref_type: 'work_order', ref_id: wo._id
      })
    ));

    // 5-4：验收后触发评价邀请（站内消息，接收人=客户本人，服务端写入）
    await sendNotification(db, {
      receiver_openid: wo.customer_openid, type: 'work_order',
      title: '服务评价邀请', content: '工单 ' + wo.work_order_no + ' 已完成验收，欢迎对本次服务进行评价（入口：工单详情）。',
      ref_type: 'work_order', ref_id: wo._id
    });

    return ok({ work_order_id: wo._id, status: WO_STATUS.ACCEPTED, need_evaluation: true });
  } catch (e) {
    console.error('[accept] accept error:', e);
    return fail(500, 'INTERNAL: accept failed');
  }
}

async function rejectWorkOrder(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      work_order_id: { type: 'string', max: 64, required: true },
      reason: { type: 'string', max: 500, required: true } // 驳回原因必填
    });
  } catch (e) {
    return fail(400, 'INVALID_PARAMS');
  }
  const ctx = await authGuard(event, { action: ACTIONS.WO_REJECT });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db, openid, role } = ctx;

  try {
    const woRes = await db.collection(COLLECTIONS.WORK_ORDERS)
      .where(Object.assign({}, ctx.rowFilter, { _id: p.work_order_id })).limit(1).get();
    if (!woRes.data.length) return fail(404, 'WORK_ORDER_NOT_FOUND');
    const wo = woRes.data[0];

    // ① 越权驳回拒绝
    const own = assertOwner(wo, openid);
    if (!own.ok) return fail(own.code, own.msg);

    // ② 状态机校验：待验收 → 驳回
    try {
      assertTransition(wo.status, WO_STATUS.REJECTED);
    } catch (e) {
      return fail(409, 'INVALID_TRANSITION');
    }

    const now = new Date();
    await db.collection(COLLECTIONS.WORK_ORDERS).doc(wo._id).update({
      data: {
        status: WO_STATUS.REJECTED,
        acceptance: {
          type: 'rejected',
          customer_openid: openid,
          result: p.reason,
          accepted_at: now
        },
        updated_at: now
      }
    });

    await writeAudit(db, {
      actor_openid: openid, role,
      action: 'reject', target_collection: COLLECTIONS.WORK_ORDERS, target_id: wo._id,
      before: { status: wo.status },
      after: { status: WO_STATUS.REJECTED, reason: p.reason }
    });

    // 通知工程师重新施工
    await sendNotification(db, {
      receiver_openid: wo.engineer_openid || wo.owner_openid, type: 'work_order',
      title: '工单被驳回', content: '工单 ' + wo.work_order_no + ' 被客户驳回：' + p.reason + '（可重新施工）',
      ref_type: 'work_order', ref_id: wo._id
    });

    return ok({ work_order_id: wo._id, status: WO_STATUS.REJECTED });
  } catch (e) {
    console.error('[accept] reject error:', e);
    return fail(500, 'INTERNAL: reject failed');
  }
}

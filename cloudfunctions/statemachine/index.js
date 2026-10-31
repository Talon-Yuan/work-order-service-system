/**
 * statemachine 云函数 — 任务 5-4：工单状态机与消息
 * 状态机：pending（待处理）→ processing（施工中）→ pending_acceptance（待验收）
 *        → accepted（已验收）/ rejected（驳回）→ closed（已闭环）
 * 核心安全：
 *  - 状态不可跳级、非法流转拒绝（common/workflow.js 的 assertTransition/checkTransition）；
 *  - 仅 owner/admin 可发起服务端流转（wo.transition）；客户验收/驳回走 accept 云函数；
 *  - 每次流转写 audit_logs；
 *  - 验收后评价邀请由 accept 云函数在验收通过时触发（notifications 站内消息，接收人服务端写入）；
 *  - closed 为终态，离开 closed 一律拒绝。
 */
const { ok, fail } = require('./common/response');
const { ACTIONS, COLLECTIONS, WO_STATUS, SUB_TEMPLATE_TYPES } = require('./common/constants');
const { cleanInput } = require('./common/security');
const { authGuard } = require('./common/authGuard');
const { checkTransition, assertTransition, writeAudit, sendNotification } = require('./common/workflow');

exports.main = async (event) => {
  const action = event && event.action;
  if (action === 'wo.transition') return transition(event);
  if (action === 'wo.status') return statusInfo(event);
  return fail(400, 'UNKNOWN_ACTION');
};

/** 5-4a：服务端状态流转（不可跳级） */
async function transition(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      work_order_id: { type: 'string', max: 64, required: true },
      to_status: { type: 'string', max: 20, required: true },
      reason: { type: 'string', max: 300, default: '' }
    });
  } catch (e) {
    return fail(400, 'INVALID_PARAMS');
  }
  // 目标状态白名单：只允许状态机定义的 6 个状态
  const allowedStatus = [WO_STATUS.PROCESSING, WO_STATUS.PENDING_ACCEPTANCE, WO_STATUS.CLOSED];
  if (allowedStatus.indexOf(p.to_status) < 0) {
    return fail(400, 'INVALID_TARGET_STATUS');
  }

  const ctx = await authGuard(event, { action: ACTIONS.WO_TRANSITION });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db, openid, role } = ctx;

  try {
    const woRes = await db.collection(COLLECTIONS.WORK_ORDERS)
      .where(Object.assign({}, ctx.rowFilter, { _id: p.work_order_id })).limit(1).get();
    if (!woRes.data.length) return fail(404, 'WORK_ORDER_NOT_FOUND');
    const wo = woRes.data[0];

    // ① 状态机校验：非法/跳级流转拒绝
    const tr = checkTransition(wo.status, p.to_status);
    if (!tr.ok) {
      // 审计一次非法尝试（安全监控）
      await writeAudit(db, {
        actor_openid: openid, role,
        action: 'transition_rejected', target_collection: COLLECTIONS.WORK_ORDERS, target_id: wo._id,
        before: { status: wo.status },
        after: { to_status: p.to_status, reason: tr.reason }
      });
      return fail(409, 'INVALID_TRANSITION');
    }

    // ② 终态闭环要求：accepted 才可 closed；closed 后不可再变
    if (p.to_status === WO_STATUS.CLOSED) {
      if (wo.status !== WO_STATUS.ACCEPTED) {
        await writeAudit(db, {
          actor_openid: openid, role, action: 'transition_rejected',
          target_collection: COLLECTIONS.WORK_ORDERS, target_id: wo._id,
          before: { status: wo.status }, after: { to_status: WO_STATUS.CLOSED, reason: 'close_requires_accepted' }
        });
        return fail(409, 'CLOSE_REQUIRES_ACCEPTED');
      }
    }

    const now = new Date();
    const updateData = { status: p.to_status, updated_at: now };
    if (p.to_status === WO_STATUS.CLOSED) {
      updateData.completed_at = now;
      updateData.need_evaluation = false; // 已闭环不再邀请评价
    }
    await db.collection(COLLECTIONS.WORK_ORDERS).doc(wo._id).update({ data: updateData });

    // ③ 审计每次流转
    await writeAudit(db, {
      actor_openid: openid, role,
      action: 'transition', target_collection: COLLECTIONS.WORK_ORDERS, target_id: wo._id,
      before: { status: wo.status },
      after: { status: p.to_status, reason: p.reason }
    });

    // ④ 通知接收人（服务端写入）
    const notifyTargets = [];
    if (p.to_status === WO_STATUS.PROCESSING) {
      // 通知客户：开始施工
      notifyTargets.push({ openid: wo.customer_openid, title: '工单开始施工', content: '工单 ' + wo.work_order_no + ' 已进入施工中状态。' });
    } else if (p.to_status === WO_STATUS.PENDING_ACCEPTANCE) {
      // 通知客户：待验收
      notifyTargets.push({ openid: wo.customer_openid, title: '工单待验收', content: '工单 ' + wo.work_order_no + ' 施工完成，请进行验收或驳回。' });
    } else if (p.to_status === WO_STATUS.CLOSED) {
      // 通知客户：已闭环
      notifyTargets.push({ openid: wo.customer_openid, title: '工单已闭环', content: '工单 ' + wo.work_order_no + ' 已闭环，感谢您的信任。' });
    }
    await Promise.all(notifyTargets.filter((t) => t.openid).map((t) =>
      sendNotification(db, {
        receiver_openid: t.openid, type: 'work_order',
        title: t.title, content: t.content, ref_type: 'work_order', ref_id: wo._id
      })
    ));

    // ⑤ 订阅消息推送（工单进度模板；6-3 触达链路：内部密钥调用 subscribe 云函数）
    const progressMsg = {
      [WO_STATUS.PROCESSING]: '工单开始施工',
      [WO_STATUS.PENDING_ACCEPTANCE]: '工单待验收',
      [WO_STATUS.CLOSED]: '工单已闭环'
    };
    if (progressMsg[p.to_status] && wo.customer_openid) {
      await trySendSubscribe(wo.customer_openid, 'pages/workorder-detail/workorder-detail?id=' + wo._id, {
        thing1: { value: progressMsg[p.to_status] },
        thing2: { value: (wo.work_order_no || '').slice(0, 20) }
      });
    }

    return ok({ work_order_id: wo._id, from: wo.status, to: p.to_status, transitioned_at: now });
  } catch (e) {
    console.error('[statemachine] transition error:', e);
    return fail(500, 'INTERNAL: transition failed');
  }
}

/** 5-4b：查询状态机定义与工单当前状态（仅授权） */
async function statusInfo(event) {
  const ctx = await authGuard(event, { action: ACTIONS.WO_LIST });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  return ok({
    transitions: {
      pending: ['processing'],
      processing: ['pending_acceptance'],
      pending_acceptance: ['accepted', 'rejected'],
      accepted: ['closed'],
      rejected: ['processing', 'closed'],
      closed: []
    },
    note: 'accepted/rejected 由 accept 云函数（客户本人）产生；closed 为终态'
  });
}


/** 6-3 触达链路：发送工单进度订阅消息（未配置内部密钥时跳过，站内通知仍生效） */
async function trySendSubscribe(touser_openid, page, data) {
  const key = process.env.SUBSCRIBE_INTERNAL_KEY;
  if (!key) return;
  try {
    const cloud = require('wx-server-sdk');
    await cloud.callFunction({
      name: 'subscribe',
      data: {
        action: 'subscribe.send', _internal_key: key,
        template_type: SUB_TEMPLATE_TYPES.WORK_ORDER_PROGRESS,
        touser_openid, page, data
      }
    });
  } catch (e) {
    console.error('[statemachine] send subscribe error:', e.message);
  }
}

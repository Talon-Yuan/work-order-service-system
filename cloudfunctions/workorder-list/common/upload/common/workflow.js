/**
 * workflow.js — 工单状态机 / 审计 / 站内消息公共模块（V3.1 阶段5）
 * 状态机：pending（待处理）→ processing（施工中）→ pending_acceptance（待验收）
 *        → accepted（已验收）/ rejected（驳回）→ closed（已闭环）
 * 核心安全：
 *  - 状态不可跳级：所有流转必须命中 CAN_TRANSITIONS，非法流转抛 INVALID_TRANSITION
 *  - 验收/驳回/闭环均带 openid 归属校验（由调用方在读取工单后执行）
 *  - 关键操作一律写 audit_logs（actor_openid 由服务端写入，禁伪造）
 *  - 通知接收人由服务端写入，禁客户端指定收件人（防定向伪造）
 */
const { COLLECTIONS } = require('./constants');

/**
 * 工单状态机合法流转表（不可跳级）
 *  key: 当前状态 -> 允许的下一个状态集合
 *  说明：rejected 允许重新施工（rejected→processing）或直接闭环（rejected→closed）；
 *        accepted 仅可闭环；closed 为终态，任何离开 closed 的流转均非法。
 */
const CAN_TRANSITIONS = {
  pending: ['processing'],
  processing: ['pending_acceptance'],
  pending_acceptance: ['accepted', 'rejected'],
  accepted: ['closed'],
  rejected: ['processing', 'closed'],
  closed: []
};

/** 状态机校验：from -> to 非法时抛业务错误（由调用方 response.fail 兜底） */
function assertTransition(from, to) {
  if (from === to) {
    throw new Error('INVALID_TRANSITION:SAME_STATUS');
  }
  const allowed = CAN_TRANSITIONS[from];
  if (!allowed || allowed.indexOf(to) < 0) {
    throw new Error('INVALID_TRANSITION:' + from + '->' + to);
  }
  return true;
}

/** 状态机校验：返回 { ok, reason } 而非抛异常（供状态机云函数用） */
function checkTransition(from, to) {
  try {
    assertTransition(from, to);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }
}

/**
 * 写审计日志（关键操作强制审计）
 * @param {object} db 云数据库句柄
 * @param {object} opts { actor_openid, role, action, target_collection, target_id, before, after, ip }
 */
async function writeAudit(db, opts) {
  const now = new Date();
  const entry = {
    actor_openid: opts.actor_openid,             // 服务端身份，禁前端传
    role: opts.role || '',
    action: opts.action || 'update',             // create/update/transition/accept/reject/close/upload/generate
    target_collection: opts.target_collection || COLLECTIONS.WORK_ORDERS,
    target_id: opts.target_id || '',
    before: opts.before || null,                 // 变更前摘要（不落敏感字段）
    after: opts.after || null,                   // 变更后摘要（不落敏感字段）
    ip: opts.ip || '',                           // 来源 IP（脱敏，可选）
    created_at: now
  };
  try {
    await db.collection(COLLECTIONS.AUDIT_LOGS).add({ data: entry });
  } catch (e) {
    // 审计写入失败不允许阻塞主流程（但生产建议告警）；此处吞掉避免业务中断
    console.error('[workflow] writeAudit failed', e && e.message);
  }
  return entry;
}

/**
 * 站内消息通知（接收人由服务端写入）
 * @param {object} db 云数据库句柄
 * @param {object} opts { receiver_openid, to_role, type, title, content, ref_type, ref_id }
 */
async function sendNotification(db, opts) {
  const now = new Date();
  const entry = {
    receiver_openid: opts.receiver_openid || '', // 服务端写入，禁客户端指定
    to_role: opts.to_role || '',
    type: opts.type || 'work_order',             // system/appointment/work_order/order/knowledge/report
    title: opts.title || '',
    content: opts.content || '',
    ref_type: opts.ref_type || 'work_order',
    ref_id: opts.ref_id || '',
    is_read: false,
    created_at: now
  };
  try {
    await db.collection(COLLECTIONS.NOTIFICATIONS).add({ data: entry });
  } catch (e) {
    console.error('[workflow] sendNotification failed', e && e.message);
  }
  return entry;
}

/** 生成唯一业务单号（工单号/报告号） */
function genNo(prefix) {
  const d = new Date();
  const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return prefix + ymd + '-' + rand;
}

module.exports = { CAN_TRANSITIONS, assertTransition, checkTransition, writeAudit, sendNotification, genNo };

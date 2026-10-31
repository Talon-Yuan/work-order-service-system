/**
 * evaluation/index.js — 服务评价与回访计划（V3.1 阶段8-2）
 * 范围：
 *  - eval.create   服务评价提交（仅工单客户本人；工单 accepted/closed 可评；work_order_id 唯一防重复）
 *  - eval.list     评价列表（客户=本人评价；工程师=被评本人；owner/admin=全量）
 *  - eval.stats    满意度统计（内部角色 owner/engineer/admin；客户 403；工程师仅本人被评）
 *  - visit.create  回访计划创建（owner/admin，服务端写 owner_openid）
 *  - visit.list    回访计划列表（客户=本人；owner/admin=全量）
 *  - visit.record  回访结果记录（owner/admin，status pending -> done/skipped + feedback）
 * 安全红线：
 *  - 身份零信任：customer_openid / engineer_openid / owner_openid 一律服务端写入，丢弃前端传入
 *  - 行级隔离：评价人 openid 匹配工单 customer_openid；统计按角色过滤；回访客户仅见本人
 *  - 内容清洗：文本 trim + 长度上限，标签走白名单，防 NoSQL 注入键
 *  - 关键操作写 audit_logs；提交接口限流（滑动窗口）
 */
const cloud = require('wx-server-sdk');
const { authGuard } = require('./common/authGuard');
const { COLLECTIONS, ACTIONS, ROLES, WO_STATUS } = require('./common/constants');
const { ok, fail } = require('./common/response');
const { writeAudit } = require('./common/workflow');
const { checkRateLimit } = require('./common/rateLimit');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const EVAL_TAGS = ['professional', 'punctual', 'polite', 'price']; // 专业/守时/礼貌/价格
const VISIT_STATUS = { PENDING: 'pending', DONE: 'done', SKIPPED: 'skipped' };
const EVAL_ALLOWED_STATUS = [WO_STATUS.ACCEPTED, WO_STATUS.CLOSED];

function str(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max || 500);
}
function maskOpenid(s) {
  const t = String(s || '');
  return t.length > 10 ? t.slice(0, 6) + '****' + t.slice(-4) : (t ? '***' : '');
}

exports.main = async (event) => {
  const action = event.action;
  try {
    switch (action) {
      case 'eval.create': return await evalCreate(event);
      case 'eval.list': return await evalList(event);
      case 'eval.stats': return await evalStats(event);
      case 'visit.create': return await visitCreate(event);
      case 'visit.list': return await visitList(event);
      case 'visit.record': return await visitRecord(event);
      default: return fail(400, 'UNKNOWN_ACTION');
    }
  } catch (e) {
    console.error('[evaluation] error:', e);
    return fail(500, 'SERVER_ERROR');
  }
};

async function loadWorkOrder(db, id) {
  try {
    const res = await db.collection(COLLECTIONS.WORK_ORDERS).doc(id).get();
    return res.data || null;
  } catch (e) {
    return null;
  }
}

async function evalCreate(event) {
  const ctx = await authGuard(event, { action: ACTIONS.EVAL_CREATE });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db, openid, role } = ctx;

  const rl = checkRateLimit('eval.create', openid, 10);
  if (!rl.ok) return fail(429, 'TOO_FREQUENT');

  const work_order_id = str(event.work_order_id, 64);
  const rating = Number(event.rating);
  const rawTags = Array.isArray(event.tags) ? event.tags : [];
  const content = str(event.content, 500);
  if (!work_order_id) return fail(400, 'WORK_ORDER_ID_REQUIRED');
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return fail(400, 'RATING_INVALID');
  if (rawTags.length > 5) return fail(400, 'TAG_INVALID');
  const tags = rawTags.filter((t) => EVAL_TAGS.indexOf(t) >= 0);
  if (tags.length !== rawTags.length) return fail(400, 'TAG_INVALID');

  const wo = await loadWorkOrder(db, work_order_id);
  if (!wo) return fail(404, 'WORK_ORDER_NOT_FOUND');
  if (wo.customer_openid !== openid) return fail(403, 'WORK_ORDER_NOT_ACCESSIBLE');
  if (EVAL_ALLOWED_STATUS.indexOf(wo.status) < 0) return fail(400, 'EVAL_NOT_ALLOWED_STATUS');

  const dup = await db.collection(COLLECTIONS.EVALUATIONS).where({ work_order_id }).limit(1).get();
  if (dup.data.length > 0) return fail(409, 'EVAL_ALREADY_EXISTS');

  const now = new Date();
  const doc = {
    work_order_id,
    customer_openid: openid,
    engineer_openid: wo.engineer_openid || '',
    rating,
    tags,
    content,
    reply: '',
    created_at: now
  };
  const addRes = await db.collection(COLLECTIONS.EVALUATIONS).add({ data: doc });
  await writeAudit(db, {
    actor_openid: openid, role, action: 'eval.create',
    target_collection: COLLECTIONS.EVALUATIONS, target_id: addRes._id,
    after: { work_order_id, rating, tag_count: tags.length }
  });
  return ok({ evaluation_id: addRes._id, rating, tags, content });
}

async function evalList(event) {
  const ctx = await authGuard(event, { action: ACTIONS.EVAL_LIST });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db, openid, role } = ctx;
  const page = Math.max(1, Number(event.page) || 1);
  const page_size = Math.min(50, Math.max(1, Number(event.page_size) || 20));

  const where = {};
  if (role === ROLES.CUSTOMER) where.customer_openid = openid;
  else if (role === ROLES.ENGINEER) where.engineer_openid = openid;
  // owner/admin 全量（管理视角）

  const cond = Object.keys(where).length ? db.collection(COLLECTIONS.EVALUATIONS).where(where)
    : db.collection(COLLECTIONS.EVALUATIONS);
  const res = await cond.orderBy('created_at', 'desc').skip((page - 1) * page_size).limit(page_size).get();
  const list = res.data.map((x) => ({
    ...x,
    customer_openid: role === ROLES.CUSTOMER ? '' : maskOpenid(x.customer_openid),
    engineer_openid: maskOpenid(x.engineer_openid)
  }));
  const cnt = await cond.count();
  return ok({ list, total: cnt.total || list.length });
}

async function evalStats(event) {
  const ctx = await authGuard(event, { action: ACTIONS.EVAL_STATS });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db, openid, role } = ctx;

  const now = new Date();
  const start = event.start ? new Date(event.start) : new Date(now.getTime() - 30 * 86400000);
  const end = event.end ? new Date(event.end) : now;
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return fail(400, 'DATE_RANGE_INVALID');

  const $ = db.command.aggregate;
  const match = { created_at: db.command.gte(start).and(db.command.lte(end)) };
  if (role === ROLES.ENGINEER) match.engineer_openid = openid; // 工程师仅本人被评统计

  const distRes = await db.collection(COLLECTIONS.EVALUATIONS).aggregate()
    .match(match)
    .group({ _id: '$rating', count: $.sum(1) })
    .end();
  const avgRes = await db.collection(COLLECTIONS.EVALUATIONS).aggregate()
    .match(match)
    .group({ _id: null, avg: $.avg('$rating'), count: $.sum(1) })
    .end();
  const engRes = await db.collection(COLLECTIONS.EVALUATIONS).aggregate()
    .match(match)
    .group({ _id: '$engineer_openid', avg: $.avg('$rating'), count: $.sum(1) })
    .sort({ count: -1 })
    .limit(10)
    .end();

  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  (distRes.list || []).forEach((g) => { if (g._id >= 1 && g._id <= 5) dist[g._id] = g.count; });
  const total = (avgRes.list && avgRes.list[0] && avgRes.list[0].count) || 0;
  const avg_rating = total ? Math.round(((avgRes.list[0].avg) || 0) * 100) / 100 : 0;
  const top_engineers = (engRes.list || []).map((g) => ({
    engineer_openid: maskOpenid(String(g._id)),
    avg: Math.round((g.avg || 0) * 100) / 100,
    count: g.count
  }));
  return ok({ total, avg_rating, dist, top_engineers, start, end });
}

async function visitCreate(event) {
  const ctx = await authGuard(event, { action: ACTIONS.VISIT_CREATE });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db, openid, role } = ctx;

  const customer_openid = str(event.customer_openid, 64);
  const work_order_id = str(event.work_order_id, 64);
  const content = str(event.content, 300);
  const visit_date = event.visit_date ? new Date(event.visit_date) : null;
  if (!customer_openid) return fail(400, 'CUSTOMER_REQUIRED');
  if (!content) return fail(400, 'CONTENT_REQUIRED');
  if (!visit_date || Number.isNaN(visit_date.getTime())) return fail(400, 'VISIT_DATE_INVALID');

  // 校验目标客户存在（users._openid 匹配），防伪造目标
  const userRes = await db.collection(COLLECTIONS.USERS).where({ _openid: customer_openid }).limit(1).get();
  if (!userRes.data.length) return fail(404, 'CUSTOMER_NOT_FOUND');

  const now = new Date();
  const doc = {
    customer_openid,
    owner_openid: openid,
    work_order_id: work_order_id || '',
    visit_date,
    content,
    status: VISIT_STATUS.PENDING,
    feedback: '',
    created_at: now,
    updated_at: now
  };
  const addRes = await db.collection(COLLECTIONS.VISIT_PLANS).add({ data: doc });
  await writeAudit(db, {
    actor_openid: openid, role, action: 'visit.create',
    target_collection: COLLECTIONS.VISIT_PLANS, target_id: addRes._id,
    after: { customer_openid: maskOpenid(customer_openid), work_order_id, visit_date }
  });
  return ok({ visit_id: addRes._id });
}

async function visitList(event) {
  const ctx = await authGuard(event, { action: ACTIONS.VISIT_LIST });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db, openid, role } = ctx;
  const page = Math.max(1, Number(event.page) || 1);
  const page_size = Math.min(50, Math.max(1, Number(event.page_size) || 20));
  const status = str(event.status, 20);

  const where = {};
  if (role === ROLES.CUSTOMER) where.customer_openid = openid; // 客户仅见本人回访
  if (status && VISIT_STATUS[status.toUpperCase()]) where.status = status;

  const cond = Object.keys(where).length ? db.collection(COLLECTIONS.VISIT_PLANS).where(where)
    : db.collection(COLLECTIONS.VISIT_PLANS);
  const res = await cond.orderBy('visit_date', 'desc').skip((page - 1) * page_size).limit(page_size).get();
  const cnt = await cond.count();
  return ok({ list: res.data, total: cnt.total || res.data.length });
}

async function visitRecord(event) {
  const ctx = await authGuard(event, { action: ACTIONS.VISIT_RECORD });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db, openid, role } = ctx;

  const visit_id = str(event.visit_id, 64);
  const status = str(event.status, 20);
  const feedback = str(event.feedback, 500);
  if (!visit_id) return fail(400, 'VISIT_ID_REQUIRED');
  if (!VISIT_STATUS[status.toUpperCase()] || status === VISIT_STATUS.PENDING) return fail(400, 'VISIT_STATUS_INVALID');

  let visitDoc = null;
  try {
    const res = await db.collection(COLLECTIONS.VISIT_PLANS).doc(visit_id).get();
    visitDoc = res.data;
  } catch (e) { /* not found */ }
  if (!visitDoc) return fail(404, 'VISIT_NOT_FOUND');

  const now = new Date();
  await db.collection(COLLECTIONS.VISIT_PLANS).doc(visit_id).update({
    data: { status, feedback, updated_at: now }
  });
  await writeAudit(db, {
    actor_openid: openid, role, action: 'visit.record',
    target_collection: COLLECTIONS.VISIT_PLANS, target_id: visit_id,
    before: { status: visitDoc.status },
    after: { status, feedback_len: feedback.length }
  });
  return ok({ visit_id });
}

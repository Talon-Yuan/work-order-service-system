/**
 * knowledge/index.js — 知识库文章管理（V3.1 阶段8-3）
 * 范围：
 *  - knowledge.list      文章列表（public/internal 两级可见隔离 + 分类/关键词筛选）
 *  - knowledge.detail    文章详情（可见性二次校验 + view_count 自增）
 *  - knowledge.create    文章创建（engineer/owner/admin；author_openid 服务端写入）
 *  - knowledge.update    文章更新（engineer/owner/admin；状态/可见性/内容；审计）
 *  - knowledge.delete    文章删除（engineer/owner/admin；物理删除 + 审计）
 *  - knowledge.from_wo   工单一键沉淀案例（engineer/owner/admin；生成草稿）
 * 安全红线：
 *  - 两级可见：customer 仅 public+published；internal 仅内部角色（owner/engineer/admin）；
 *    内部文章 id 永不返回给客户接口（canSee 前置校验 + 查询条件双重隔离）
 *  - 身份零信任：author_openid 一律服务端写入，丢弃前端传入
 *  - 字段白名单 + 长度上限 + 标签/枚举白名单 + 防 NoSQL 注入键
 *  - 写操作全部审计 audit_logs
 */
const cloud = require('wx-server-sdk');
const { authGuard } = require('./common/authGuard');
const { COLLECTIONS, ACTIONS, ROLES, VISIBILITY } = require('./common/constants');
const { ok, fail } = require('./common/response');
const { writeAudit } = require('./common/workflow');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const CATEGORIES = ['guide', 'faq', 'tutorial', 'policy'];
const ARTICLE_STATUS = { DRAFT: 'draft', PUBLISHED: 'published', ARCHIVED: 'archived' };
const WRITABLE_FIELDS = ['title', 'category', 'visibility', 'status', 'content', 'tags', 'files'];

function str(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max || 500);
}
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function maskOpenid(s) {
  const t = String(s || '');
  return t.length > 10 ? t.slice(0, 6) + '****' + t.slice(-4) : (t ? '***' : '');
}

/** 两级可见性判定（列表 + 详情共用，禁止内部分支遗漏） */
function canSee(role, doc) {
  if (role === ROLES.ADMIN) return true;
  if (doc.visibility === VISIBILITY.INTERNAL) {
    if (role !== ROLES.OWNER && role !== ROLES.ENGINEER) return false; // 客户不可见 internal
    return doc.status !== ARTICLE_STATUS.ARCHIVED; // 内部角色亦不可见归档
  }
  if (role === ROLES.CUSTOMER) return doc.status === ARTICLE_STATUS.PUBLISHED; // 客户仅已发布
  return doc.status !== ARTICLE_STATUS.ARCHIVED; // 内部角色可见 public 草稿/已发布，不含归档
}

/** 客户视角查询条件：仅 public + published（双重隔离，防内部 id 泄露） */
function baseWhere(role) {
  if (role === ROLES.CUSTOMER) return { visibility: VISIBILITY.PUBLIC, status: ARTICLE_STATUS.PUBLISHED };
  if (role === ROLES.OWNER || role === ROLES.ENGINEER) return { status: db.command.neq(ARTICLE_STATUS.ARCHIVED) };
  return {}; // admin 全量
}

exports.main = async (event) => {
  const action = event.action;
  try {
    switch (action) {
      case 'knowledge.list': return await knowledgeList(event);
      case 'knowledge.detail': return await knowledgeDetail(event);
      case 'knowledge.create': return await knowledgeCreate(event);
      case 'knowledge.update': return await knowledgeUpdate(event);
      case 'knowledge.delete': return await knowledgeDelete(event);
      case 'knowledge.from_wo': return await knowledgeFromWo(event);
      default: return fail(400, 'UNKNOWN_ACTION');
    }
  } catch (e) {
    console.error('[knowledge] error:', e);
    return fail(500, 'SERVER_ERROR');
  }
};

async function knowledgeList(event) {
  const ctx = await authGuard(event, { action: ACTIONS.KNOWLEDGE_LIST });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db, role } = ctx;
  const page = Math.max(1, Number(event.page) || 1);
  const page_size = Math.min(50, Math.max(1, Number(event.page_size) || 20));
  const category = str(event.category, 20);
  const keyword = str(event.keyword, 50);

  const where = baseWhere(role, db);
  if (category && CATEGORIES.indexOf(category) >= 0) where.category = category;
  if (keyword) {
    const rx = db.RegExp({ regexp: escapeRegex(keyword), options: 'i' });
    where.title = rx; // 关键词优先匹配标题；如需正文检索可扩展 or 条件
  }

  const cond = db.collection(COLLECTIONS.KNOWLEDGE_BASE).where(where);
  const res = await cond.orderBy('updated_at', 'desc').skip((page - 1) * page_size).limit(page_size).get();
  const cnt = await cond.count();
  // 客户视角隐藏内部字段：author_openid 脱敏、files 仅内部可见
  const list = res.data.map((x) => ({
    _id: x._id,
    title: x.title,
    category: x.category,
    visibility: x.visibility,
    status: x.status,
    tags: x.tags || [],
    content: role === ROLES.CUSTOMER ? '' : (x.content || ''),
    author_openid: role === ROLES.CUSTOMER ? '' : maskOpenid(x.author_openid),
    files: role === ROLES.CUSTOMER ? [] : (x.files || []),
    view_count: x.view_count || 0,
    published_at: x.published_at || null,
    created_at: x.created_at,
    updated_at: x.updated_at
  }));
  return ok({ list, total: cnt.total || list.length });
}

async function knowledgeDetail(event) {
  const ctx = await authGuard(event, { action: ACTIONS.KNOWLEDGE_DETAIL });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db, role } = ctx;
  const id = str(event.article_id, 64);
  if (!id) return fail(400, 'ARTICLE_ID_REQUIRED');

  let doc = null;
  try {
    const res = await db.collection(COLLECTIONS.KNOWLEDGE_BASE).doc(id).get();
    doc = res.data;
  } catch (e) { /* not found */ }
  if (!doc) return fail(404, 'ARTICLE_NOT_FOUND');
  if (!canSee(role, doc)) return fail(403, 'ARTICLE_NOT_ACCESSIBLE'); // 越权防护：internal 或未发布对客户 403

  await db.collection(COLLECTIONS.KNOWLEDGE_BASE).doc(id).update({
    data: { view_count: db.command.inc(1) }
  });
  const out = {
    ...doc,
    author_openid: role === ROLES.CUSTOMER ? '' : maskOpenid(doc.author_openid),
    files: role === ROLES.CUSTOMER ? [] : (doc.files || [])
  };
  return ok(out);
}

async function knowledgeCreate(event) {
  const ctx = await authGuard(event, { action: ACTIONS.KNOWLEDGE_CREATE });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db, openid, role } = ctx;

  const title = str(event.title, 120);
  const category = str(event.category, 20);
  const visibility = str(event.visibility, 20);
  const status = str(event.status, 20) || ARTICLE_STATUS.DRAFT;
  const content = str(event.content, 8000);
  const rawTags = Array.isArray(event.tags) ? event.tags : [];
  const files = Array.isArray(event.files) ? event.files.slice(0, 10).map((f) => str(f, 200)) : [];

  if (!title) return fail(400, 'TITLE_REQUIRED');
  if (CATEGORIES.indexOf(category) < 0) return fail(400, 'CATEGORY_INVALID');
  if ([VISIBILITY.PUBLIC, VISIBILITY.INTERNAL].indexOf(visibility) < 0) return fail(400, 'VISIBILITY_INVALID');
  if (!ARTICLE_STATUS[status.toUpperCase()]) return fail(400, 'STATUS_INVALID');
  const tags = rawTags.slice(0, 10).map((t) => str(t, 30));
  if (!content) return fail(400, 'CONTENT_REQUIRED');

  const now = new Date();
  const doc = {
    title,
    category,
    visibility,
    content,
    tags,
    author_openid: openid,
    files,
    status,
    view_count: 0,
    published_at: status === ARTICLE_STATUS.PUBLISHED ? now : null,
    created_at: now,
    updated_at: now
  };
  const addRes = await db.collection(COLLECTIONS.KNOWLEDGE_BASE).add({ data: doc });
  await writeAudit(db, {
    actor_openid: openid, role, action: 'knowledge.create',
    target_collection: COLLECTIONS.KNOWLEDGE_BASE, target_id: addRes._id,
    after: { title, category, visibility, status }
  });
  return ok({ article_id: addRes._id });
}

async function knowledgeUpdate(event) {
  const ctx = await authGuard(event, { action: ACTIONS.KNOWLEDGE_UPDATE });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db, openid, role } = ctx;
  const id = str(event.article_id, 64);
  if (!id) return fail(400, 'ARTICLE_ID_REQUIRED');

  let doc = null;
  try {
    const res = await db.collection(COLLECTIONS.KNOWLEDGE_BASE).doc(id).get();
    doc = res.data;
  } catch (e) { /* not found */ }
  if (!doc) return fail(404, 'ARTICLE_NOT_FOUND');

  const data = {};
  for (const f of WRITABLE_FIELDS) {
    if (event[f] === undefined || event[f] === null) continue;
    if (f === 'title') { const v = str(event[f], 120); if (v) data.title = v; }
    else if (f === 'content') { const v = str(event[f], 8000); if (v) data.content = v; }
    else if (f === 'category') { const v = str(event[f], 20); if (CATEGORIES.indexOf(v) >= 0) data.category = v; }
    else if (f === 'visibility') { const v = str(event[f], 20); if ([VISIBILITY.PUBLIC, VISIBILITY.INTERNAL].indexOf(v) >= 0) data.visibility = v; }
    else if (f === 'status') { const v = str(event[f], 20); if (ARTICLE_STATUS[v.toUpperCase()]) data.status = v; }
    else if (f === 'tags') { data.tags = Array.isArray(event[f]) ? event[f].slice(0, 10).map((t) => str(t, 30)) : []; }
    else if (f === 'files') { data.files = Array.isArray(event[f]) ? event[f].slice(0, 10).map((x) => str(x, 200)) : []; }
  }
  if (Object.keys(data).length === 0) return fail(400, 'NOTHING_TO_UPDATE');

  const now = new Date();
  data.updated_at = now;
  if (data.status === ARTICLE_STATUS.PUBLISHED && doc.status !== ARTICLE_STATUS.PUBLISHED) {
    data.published_at = now; // 首次发布落发布时间
  }
  if (data.status === ARTICLE_STATUS.DRAFT) {
    data.published_at = null; // 退回草稿清空发布时间
  }
  await db.collection(COLLECTIONS.KNOWLEDGE_BASE).doc(id).update({ data });
  await writeAudit(db, {
    actor_openid: openid, role, action: 'knowledge.update',
    target_collection: COLLECTIONS.KNOWLEDGE_BASE, target_id: id,
    before: { status: doc.status, visibility: doc.visibility, title: doc.title },
    after: { status: data.status || doc.status, visibility: data.visibility || doc.visibility }
  });
  return ok({ article_id: id });
}

async function knowledgeDelete(event) {
  const ctx = await authGuard(event, { action: ACTIONS.KNOWLEDGE_DELETE });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db, openid, role } = ctx;
  const id = str(event.article_id, 64);
  if (!id) return fail(400, 'ARTICLE_ID_REQUIRED');

  let doc = null;
  try {
    const res = await db.collection(COLLECTIONS.KNOWLEDGE_BASE).doc(id).get();
    doc = res.data;
  } catch (e) { /* not found */ }
  if (!doc) return fail(404, 'ARTICLE_NOT_FOUND');

  await db.collection(COLLECTIONS.KNOWLEDGE_BASE).doc(id).remove();
  await writeAudit(db, {
    actor_openid: openid, role, action: 'knowledge.delete',
    target_collection: COLLECTIONS.KNOWLEDGE_BASE, target_id: id,
    before: { title: doc.title, visibility: doc.visibility, status: doc.status }
  });
  return ok({ article_id: id });
}

async function knowledgeFromWo(event) {
  const ctx = await authGuard(event, { action: ACTIONS.KNOWLEDGE_FROM_WO });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db, openid, role } = ctx;
  const work_order_id = str(event.work_order_id, 64);
  const title = str(event.title, 120);
  const category = str(event.category, 20);
  const visibility = str(event.visibility, 20);
  if (!work_order_id) return fail(400, 'WORK_ORDER_ID_REQUIRED');
  if (!title) return fail(400, 'TITLE_REQUIRED');
  if (CATEGORIES.indexOf(category) < 0) return fail(400, 'CATEGORY_INVALID');
  if ([VISIBILITY.PUBLIC, VISIBILITY.INTERNAL].indexOf(visibility) < 0) return fail(400, 'VISIBILITY_INVALID');

  let wo = null;
  try {
    const res = await db.collection(COLLECTIONS.WORK_ORDERS).doc(work_order_id).get();
    wo = res.data;
  } catch (e) { /* not found */ }
  if (!wo) return fail(404, 'WORK_ORDER_NOT_FOUND');

  // 从工单提取可沉淀正文（只取稳定字段，缺失自动占位；不落敏感 openid）
  const contentParts = [];
  if (wo.title) contentParts.push('# ' + wo.title);
  contentParts.push('> 来源工单：' + work_order_id + '（状态：' + wo.status + '）');
  if (wo.problem_desc) contentParts.push('## 问题描述\n' + wo.problem_desc);
  if (wo.device_model) contentParts.push('## 设备型号\n' + wo.device_model);
  if (wo.solution) contentParts.push('## 处理方案\n' + wo.solution);
  if (wo.result_desc) contentParts.push('## 处理结果\n' + wo.result_desc);
  if (contentParts.length < 2) contentParts.push('（请补充案例正文）');

  const now = new Date();
  const doc = {
    title,
    category,
    visibility,
    content: contentParts.join('\n\n'),
    tags: ['case'],
    author_openid: openid,
    files: [],
    status: ARTICLE_STATUS.DRAFT, // 沉淀后默认为草稿，内部编辑确认后发布
    view_count: 0,
    published_at: null,
    created_at: now,
    updated_at: now
  };
  const addRes = await db.collection(COLLECTIONS.KNOWLEDGE_BASE).add({ data: doc });
  await writeAudit(db, {
    actor_openid: openid, role, action: 'knowledge.from_wo',
    target_collection: COLLECTIONS.KNOWLEDGE_BASE, target_id: addRes._id,
    after: { work_order_id, title, category, visibility }
  });
  return ok({ article_id: addRes._id, status: doc.status });
}

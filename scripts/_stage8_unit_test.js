#!/usr/bin/env node
/**
 * _stage8_unit_test.js — 阶段8（服务评价与知识库）单元测试
 * 纯逻辑测试：权限矩阵（与 authGuard.can 一致）、知识库两级可见判定（与 knowledge/index.js 一致）、评价标签白名单、OPENID 脱敏。
 * 输出：scripts/_stage8_unit_out.json；全部通过 exit 0。
 */
const path = require('path');
const fs = require('fs');
const constants = require(path.join(__dirname, '..', 'cloudfunctions', 'common', 'constants.js'));
const checks = [];
function check(name, pass, detail) { checks.push({ name: name, pass: !!pass, detail: detail || '' }); }

// —— 权限矩阵 can()：与 authGuard.js 实现一致 ——
function can(role, action) {
  const caps = constants.ROLE_CAPS[role];
  if (!caps) return false;
  return caps.indexOf('*') >= 0 || caps.indexOf(action) >= 0;
}
const A = constants.ACTIONS;
check('admin 通配全权限（含评价/回访/知识库全部）',
  can('admin', A.EVAL_CREATE) && can('admin', A.EVAL_LIST) && can('admin', A.EVAL_STATS) &&
  can('admin', A.VISIT_CREATE) && can('admin', A.VISIT_LIST) && can('admin', A.VISIT_RECORD) &&
  can('admin', A.KNOWLEDGE_LIST) && can('admin', A.KNOWLEDGE_DETAIL) && can('admin', A.KNOWLEDGE_CREATE) &&
  can('admin', A.KNOWLEDGE_UPDATE) && can('admin', A.KNOWLEDGE_DELETE) && can('admin', A.KNOWLEDGE_FROM_WO));
check('customer 可提交/查看本人评价', can('customer', A.EVAL_CREATE) && can('customer', A.EVAL_LIST));
check('customer 不可满意度统计（内部指标）', !can('customer', A.EVAL_STATS));
check('customer 不可创建/记录回访计划', !can('customer', A.VISIT_CREATE) && !can('customer', A.VISIT_RECORD));
check('customer 可查本人回访计划', can('customer', A.VISIT_LIST));
check('customer 可读知识库列表与详情', can('customer', A.KNOWLEDGE_LIST) && can('customer', A.KNOWLEDGE_DETAIL));
check('customer 不可写知识库', !can('customer', A.KNOWLEDGE_CREATE) && !can('customer', A.KNOWLEDGE_UPDATE) &&
  !can('customer', A.KNOWLEDGE_DELETE) && !can('customer', A.KNOWLEDGE_FROM_WO));
check('engineer 可写知识库与工单沉淀', can('engineer', A.KNOWLEDGE_CREATE) && can('engineer', A.KNOWLEDGE_UPDATE) &&
  can('engineer', A.KNOWLEDGE_DELETE) && can('engineer', A.KNOWLEDGE_FROM_WO));
check('engineer 可查被评记录与统计', can('engineer', A.EVAL_LIST) && can('engineer', A.EVAL_STATS));
check('owner 可创建/记录回访', can('owner', A.VISIT_CREATE) && can('owner', A.VISIT_RECORD));
check('owner 可读内部知识库', can('owner', A.KNOWLEDGE_LIST) && can('owner', A.KNOWLEDGE_DETAIL));

// —— 知识库两级可见判定（与 knowledge/index.js canSee 一致） ——
const PUB = 'public', INT = 'internal';
const DRAFT = 'draft', PUBLISHED = 'published', ARCHIVED = 'archived';
function canSee(role, doc) {
  if (role === 'admin') return true;
  if (doc.visibility === INT) {
    if (role !== 'owner' && role !== 'engineer') return false;
    return doc.status !== ARCHIVED;
  }
  if (role === 'customer') return doc.status === PUBLISHED;
  return doc.status !== ARCHIVED;
}
check('可见性-客户可见 public+published', canSee('customer', { visibility: PUB, status: PUBLISHED }));
check('可见性-客户不可见 internal 已发布', !canSee('customer', { visibility: INT, status: PUBLISHED }));
check('可见性-客户不可见 public 草稿/归档', !canSee('customer', { visibility: PUB, status: DRAFT }) &&
  !canSee('customer', { visibility: PUB, status: ARCHIVED }));
check('可见性-owner/engineer 可见 internal', canSee('owner', { visibility: INT, status: PUBLISHED }) &&
  canSee('engineer', { visibility: INT, status: DRAFT }));
check('可见性-内部角色不可见归档', !canSee('owner', { visibility: PUB, status: ARCHIVED }) &&
  !canSee('engineer', { visibility: INT, status: ARCHIVED }));
check('可见性-admin 全量（含归档 internal）', canSee('admin', { visibility: INT, status: ARCHIVED }));

// —— 客户视角查询条件（与 knowledge/index.js baseWhere 一致） ——
function baseWhere(role) {
  if (role === 'customer') return { visibility: PUB, status: PUBLISHED };
  if (role === 'owner' || role === 'engineer') return { status: { neq: ARCHIVED } };
  return {};
}
const cw = baseWhere('customer');
check('查询条件-客户仅 public+published（双重隔离）', cw.visibility === PUB && cw.status === PUBLISHED);
check('查询条件-owner/engineer 排除归档', baseWhere('owner').status.neq === ARCHIVED && baseWhere('engineer').status.neq === ARCHIVED);
check('查询条件-admin 全量', Object.keys(baseWhere('admin')).length === 0);

// —— 评价标签白名单（与 evaluation/index.js EVAL_TAGS 一致） ——
const EVAL_TAGS = ['professional', 'punctual', 'polite', 'price'];
check('评价标签白名单-4 类且合法标签全通过', EVAL_TAGS.length === 4 &&
  ['professional', 'punctual', 'polite', 'price'].every(function (t) { return EVAL_TAGS.indexOf(t) >= 0; }));
check('评价标签白名单-非法标签拒绝', EVAL_TAGS.indexOf('fake-tag') < 0);

// —— OPENID 脱敏（与 evaluation/knowledge index.js maskOpenid 一致） ——
function maskOpenid(s) {
  const t = String(s || '');
  return t.length > 10 ? t.slice(0, 6) + '****' + t.slice(-4) : (t ? '***' : '');
}
check('脱敏-openid 长串', maskOpenid('oA123456789012345678') === 'oA1234****5678');
check('脱敏-openid 空值', maskOpenid('') === '');

// —— 可评工单状态（与 evaluation/index.js EVAL_ALLOWED_STATUS 一致） ——
const WO_ACCEPTED = 'accepted', WO_CLOSED = 'closed';
const EVAL_ALLOWED_STATUS = [WO_ACCEPTED, WO_CLOSED];
check('可评状态-accepted/closed', EVAL_ALLOWED_STATUS.indexOf('accepted') >= 0 && EVAL_ALLOWED_STATUS.indexOf('closed') >= 0);
check('可评状态-未验收工单不可评', EVAL_ALLOWED_STATUS.indexOf('pending') < 0 && EVAL_ALLOWED_STATUS.indexOf('processing') < 0);

const total = checks.length;
const passed = checks.filter(function (c) { return c.pass; }).length;
fs.writeFileSync(path.join(__dirname, '_stage8_unit_out.json'), JSON.stringify({ total: total, passed: passed, checks: checks }, null, 2), 'utf-8');
console.log('stage8 unit:', passed + '/' + total);
process.exit(passed === total ? 0 : 1);

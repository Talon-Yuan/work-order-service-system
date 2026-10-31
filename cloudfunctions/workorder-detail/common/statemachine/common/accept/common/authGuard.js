/**
 * authGuard.js — 统一鉴权与行级过滤（阶段 2/3 扩展版，对应项目书 2-1/2-2/2-3 与 V3.1 专章）
 * 安全红线落实：
 *  - 身份零信任：身份一律取自运行上下文（小程序 getWXContext() / Web Token），丢弃前端传入 ID
 *  - Web 会话：access_token 验签（tokenStore）+ token_version 比对 + token_blacklist 黑名单
 *  - 权限矩阵：ROLE_CAPS 服务端二次校验（前端隐藏菜单仅体验层，不构成防线）
 *  - 三档可见性（工单进度）：客户=本人 customer_openid；工程师=派单 engineer_openid；
 *    负责人=本人组织 owner_openid（组织范围扩展位：user.org 存在时可用 { org }）；管理员=全量
 */
const cloud = require('wx-server-sdk');
const { COLLECTIONS, ACTIONS, ROLE_CAPS, ROLES } = require('./constants');
const tokenStore = require('./tokenStore');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

/** 判断角色是否拥有动作权限 */
function can(role, action) {
  const caps = ROLE_CAPS[role];
  if (!caps) return false;
  return caps.indexOf('*') >= 0 || caps.indexOf(action) >= 0;
}

/**
 * 身份解析：
 *  - mini：优先 event._token（小程序的正式会话），否则 getWXContext().OPENID
 *  - web ：必须携带 event._token（access_token），验签通过后取 openid/role
 * 返回 { openid, role, ver, jti } 或 null
 */
async function resolveIdentity(event, db) {
  if (event && event._token) {
    const payload = tokenStore.verifyToken(event._token);
    if (!payload) return null;
    return { openid: payload.sub, role: payload.role, ver: payload.ver, jti: payload.jti, type: payload.type };
  }
  if (event && event._source === 'web') return null; // Web 未带 token 一律拒绝
  const wxContext = cloud.getWXContext();
  if (!wxContext.OPENID) return null;
  return { openid: wxContext.OPENID, role: null, ver: null, jti: null, type: null };
}

/**
 * 统一鉴权入口
 * @param {object} event 云函数入参
 * @param {object} opts { action, allowRoles }
 * 成功：返回 ctx = { openid, role, session:{...}, rowFilter, db }
 * 失败：抛业务错误（上层 response.fail 兜底），或返回 { error: { code, msg } }
 */
async function authGuard(event, opts) {
  const db = cloud.database();
  const identity = await resolveIdentity(event, db);
  if (!identity) {
    return { error: { code: 401, msg: 'UNAUTHORIZED' } };
  }

  // 拉取用户档案（服务端权威身份）
  let user = null;
  try {
    const res = await db.collection(COLLECTIONS.USERS).where({ _openid: identity.openid }).limit(1).get();
    user = res.data[0] || null;
  } catch (e) {
    return { error: { code: 500, msg: 'SERVER_ERROR' } };
  }
  if (!user) return { error: { code: 401, msg: 'UNAUTHORIZED' } };
  if (user.disabled === true) return { error: { code: 403, msg: 'ACCOUNT_DISABLED' } };

  const role = identity.role || user.role || ROLES.CUSTOMER;
  const ver = identity.ver;

  // 1) token_version 校验：改密/强制下线后旧 token 立即失效（ver 取自 token，必须等于当前值）
  if (identity.type) {
    if (typeof user.token_version !== 'number') user.token_version = 0;
    if (typeof ver !== 'number' || ver !== user.token_version) {
      return { error: { code: 401, msg: 'TOKEN_VERSION_EXPIRED' } };
    }
    // 2) 黑名单校验（jti 已吊销）
    const revoked = await tokenStore.isTokenRevoked(identity.openid, user.token_version, identity.jti);
    if (revoked) return { error: { code: 401, msg: 'TOKEN_REVOKED' } };
  }

  // 3) 动作权限
  if (opts && opts.action) {
    if (!can(role, opts.action)) {
      return { error: { code: 403, msg: 'FORBIDDEN' } };
    }
  }

  // 4) 行级过滤（三档可见性）
  const rowFilter = buildRowFilter(role, identity.openid, user);

  return {
    db,
    openid: identity.openid,
    role,
    user,
    rowFilter,
    session: { openid: identity.openid, role, ver, jti: identity.jti, type: identity.type },
    can: (action) => can(role, action)
  };
}

/**
 * 行级过滤条件（工单进度三档可见性，项目书 2-3 / 16.4）
 *  - customer：仅 customer_openid == 本人
 *  - engineer：仅 engineer_openid == 本人
 *  - owner   ：owner_openid == 本人（组织范围：user.org 存在时扩展为 { org }）
 *  - admin   ：全量 {}
 */
function buildRowFilter(role, openid, user) {
  switch (role) {
    case ROLES.CUSTOMER:
      return { customer_openid: openid };
    case ROLES.ENGINEER:
      return { engineer_openid: openid };
    case ROLES.OWNER:
      // V3.1：负责人组织范围全量。组织字段落库后传 { org: user.org } 即可覆盖全员；
      // 当前骨架以 owner_openid 本人兜底，避免空条件全量暴露。
      return user && user.org ? { org: user.org } : { owner_openid: openid };
    case ROLES.ADMIN:
      return {};
    default:
      return { customer_openid: openid };
  }
}

module.exports = { authGuard, buildRowFilter, can };

/**
 * tokenStore.js — 会话 Token（阶段 2 正式启用）
 * 设计（对应项目书 2-1 双 Token 方案 + 安全红线）：
 *  - access_token（2h）+ refresh_token（7d），HMAC-SHA256 服务端签名
 *  - 载荷含 sub(openid)/role/ver(token_version)/jti/exp，服务端验签 + 版本 + 黑名单
 *  - 密钥仅存云函数环境变量 LOGIN_SECRET（前端零密钥）；未配置时拒绝签发（不提供默认密钥兜底）
 *  - 吊销：token_blacklist 集合记录 jti，authGuard 每次请求校验；改密/强制下线 = users.token_version +1
 * 安全红线：本文件不出现任何密钥字面量；生产必须配置环境变量 LOGIN_SECRET（>=32 字符随机串）
 */
const crypto = require('crypto');
const cloud = require('wx-server-sdk');
const { COLLECTIONS } = require('./constants');
const { TOKEN_TTL } = require('./constants');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const ALG = 'HS256';
const SEP = '.';

/** 取签名密钥；未配置时抛错（禁止弱默认密钥） */
function secret() {
  const s = process.env.LOGIN_SECRET;
  if (!s || s.length < 32) {
    throw new Error('LOGIN_SECRET not configured or too short (>=32 chars)');
  }
  return s;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

/** 签发 Token（type: access | refresh） */
function signToken({ openid, role, ver, type }) {
  const ttl = type === 'refresh' ? TOKEN_TTL.REFRESH : TOKEN_TTL.ACCESS;
  const now = Math.floor(Date.now() / 1000);
  const jti = crypto.randomBytes(16).toString('hex');
  const header = b64url(JSON.stringify({ alg: ALG, typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    sub: openid, role, ver: ver || 0, type, jti, iat: now, exp: now + ttl
  }));
  const sig = crypto.createHmac('sha256', secret()).update(header + SEP + payload).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { token: header + SEP + payload + SEP + sig, exp: now + ttl, jti };
}

/** 校验 Token：验签 + 过期；返回 payload 或 null */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split(SEP);
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expect = crypto.createHmac('sha256', secret()).update(h + SEP + p).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  // 恒定时间比较防时序攻击
  const a = Buffer.from(expect); const b = Buffer.from(s);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(p));
    if (!payload.sub || !payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

/**
 * 黑名单查询：token_blacklist 命中（jti 且未过期）即视为已吊销
 * 阶段 2 正式启用；authGuard 每次请求调用
 */
async function isTokenRevoked(openid, tokenVersion, jti) {
  try {
    const db = cloud.database();
    const cmd = db.command;
    const hit = await db.collection(COLLECTIONS.TOKEN_BLACKLIST)
      .where({ jti, expires_at: cmd.gt(db.serverDate()) })
      .limit(1).get();
    return hit.data.length > 0;
  } catch (e) {
    console.error('[tokenStore] blacklist query error:', e);
    return true; // 查库失败按已吊销处理（零信任默认拒绝）
  }
}

/** 写入黑名单（登出/吊销）；expiresAt 秒级时间戳 */
async function revokeToken(openid, jti, expiresAt, reason) {
  try {
    const db = cloud.database();
    await db.collection(COLLECTIONS.TOKEN_BLACKLIST).add({
      data: {
        jti,
        openid,
        reason: reason || 'logout',
        expires_at: new Date((expiresAt || Math.floor(Date.now() / 1000) + TOKEN_TTL.ACCESS) * 1000),
        created_at: db.serverDate()
      }
    });
    return true;
  } catch (e) {
    console.error('[tokenStore] revoke error:', e);
    return false;
  }
}

module.exports = { signToken, verifyToken, isTokenRevoked, revokeToken };

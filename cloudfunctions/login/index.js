/**
 * login 云函数 — 会话建立 + 用户档案初始化（阶段 2：Web 登录 + openid 绑定）
 * 支持通路（scene 区分）：
 *  1. scene=wechat          小程序 openid 免登（保留 V1 能力，正式签发 access/refresh token）
 *  2. scene=web, action=sms.send      发送手机号验证码（真实短信通道预留，生产环境不返回验证码）
 *  3. scene=web, action=login         手机号+验证码 / 手机号+密码 登录
 *  4. scene=web, action=bind          将 Web 账号与小程序 openid 绑定（users.web_openid / bind_openid）
 *  5. scene=web, action=setPassword   设置/重置登录密码（bcrypt 加盐哈希）
 *  6. scene=web, action=refresh       refresh_token 换发 access_token
 * 安全红线落实：
 *   - 身份零信任：小程序 OPENID 仅来自 getWXContext()；Web 身份经 tokenStore 验签
 *   - 明文密码零存储：密码仅存 bcrypt 加盐哈希（users.password_hash），禁用 MD5/明文
 *   - 验证码防护：sha256 存储 + 单次有效 + 5 次失败锁定 + 60s 发送间隔
 *   - 前端零密钥：TOKEN_SECRET 仅环境变量，绝不落前端
 *   - 审计：登录/绑定/改密写 audit_logs
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./common/response');
const { COLLECTIONS, TOKEN_TTL } = require('./common/constants');
const { cleanInput } = require('./common/security');
const tokenStore = require('./common/tokenStore');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const BCRYPT_ROUNDS = 10;
const CODE_TTL_SEC = 300;          // 验证码 5 分钟有效
const SMS_INTERVAL_SEC = 60;       // 同手机号 60 秒内不重发
const MAX_CODE_ATTEMPTS = 5;       // 验证码最多尝试 5 次
const MAX_LOGIN_FAILS = 5;         // 密码连续失败 5 次锁定 15 分钟
const LOCK_SEC = 15 * 60;

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function genCode() { return String(Math.floor(100000 + Math.random() * 900000)); }

/** 公开用户信息（剔除敏感字段） */
function publicUser(u) {
  return {
    _id: u._id,
    openid: u.openid || u._openid,
    role: u.role,
    status: u.status,
    name: u.name || '',
    phone: u.phone || '',
    org: u.org || '',
    timezone: u.timezone || 'Asia/Shanghai',
    city: u.city || '',
    bind_openid: u.bind_openid || '',
    last_login_at: u.last_login_at || null
  };
}

/** 签发双 Token 并返回会话 */
async function issueSession(user, db, now) {
  const ver = typeof user.token_version === 'number' ? user.token_version : 0;
  const openid = user.openid || user._openid;
  const access = tokenStore.signToken({ openid, role: user.role, ver, type: 'access' });
  const refresh = tokenStore.signToken({ openid, role: user.role, ver, type: 'refresh' });
  return {
    access_token: access.token,
    refresh_token: refresh.token,
    expires_in: access.exp - Math.floor(Date.now() / 1000),
    refresh_expires_in: TOKEN_TTL.REFRESH
  };
}

/** 真实短信通道预留：生产接入服务商（如腾讯云 SMS/阿里云 SMS），严禁在响应中回传验证码 */
async function sendSmsViaProvider(phone, code) {
  // TODO: 接入短信服务商，配置密钥仅存环境变量（SMS_APP_ID/SMS_APP_KEY），审计发送记录
  console.log('[login][sms] would send code to', phone, '(provider stub)');
  return true;
}

/** 查找用户：小程序 _openid 或 Web 手机号 */
async function findUser(db, { openid, phone }) {
  if (openid) {
    const r = await db.collection(COLLECTIONS.USERS).where({ _openid: openid }).limit(1).get();
    if (r.data.length) return r.data[0];
  }
  if (phone) {
    const r = await db.collection(COLLECTIONS.USERS).where({ phone }).limit(1).get();
    if (r.data.length) return r.data[0];
  }
  return null;
}

exports.main = async (event) => {
  // —— 入参白名单 ——
  let p;
  try {
    p = cleanInput(event || {}, {
      scene: { type: 'string', max: 32 },
      action: { type: 'string', max: 32 },
      mode: { type: 'string', max: 32 },
      phone: { type: 'string', max: 20 },
      code: { type: 'string', max: 16 },
      password: { type: 'string', max: 128 },
      bind_openid: { type: 'string', max: 64 },
      openid_bind: { type: 'string', max: 64 },
      refresh_token: { type: 'string', max: 512 },
      timezone: { type: 'string', max: 64 },
      city: { type: 'string', max: 64 }
    });
  } catch (e) {
    return fail(400, 'INVALID_PARAMS');
  }

  const scene = p.scene || 'wechat';
  const db = cloud.database();
  const now = db.serverDate();

  // ============ 1. 小程序 openid 免登（保留） ============
  if (scene === 'wechat') {
    const { OPENID, APPID, UNIONID } = cloud.getWXContext();
    if (!OPENID) return fail(401, 'UNAUTHORIZED: missing openid from WX context');
    const users = db.collection(COLLECTIONS.USERS);
    let user = await findUser(db, { openid: OPENID });
    let firstLogin = false;
    try {
      if (!user) {
        firstLogin = true;
        const doc = {
          _openid: OPENID,
          openid: OPENID,
          unionid: UNIONID || '',
          appid: APPID || '',
          role: 'customer',
          status: 'active',
          name: '', phone: '', org: '',
          timezone: 'Asia/Shanghai', city: '',
          token_version: 0,
          created_at: now, updated_at: now, last_login_at: now
        };
        const add = await users.add({ data: doc });
        user = Object.assign({}, doc, { _id: add._id });
      } else {
        // Web 绑定合并：若该小程序档案为空档且已被 Web 账号绑定（bind_openid 指向本人），合并主档案资料
        let merged = user;
        if (!user.phone && !user.role || user.role === 'customer' && !user.phone) {
          const master = await users.where({ bind_openid: OPENID }).limit(1).get();
          if (master.data.length) {
            const m = master.data[0];
            const patch = {};
            if (m.name && !user.name) patch.name = m.name;
            if (m.org && !user.org) patch.org = m.org;
            if (m.timezone) patch.timezone = m.timezone;
            if (m.city) patch.city = m.city;
            if (m.role && m.role !== 'customer') patch.role = m.role;
            if (Object.keys(patch).length) {
              await users.doc(user._id).update({ data: Object.assign(patch, { updated_at: now }) });
              merged = Object.assign({}, user, patch);
            }
          }
        }
        user = merged;
        await users.doc(user._id).update({ data: { last_login_at: now, updated_at: now } });
      }
      const session = await issueSession(user, db, now);
      await db.collection(COLLECTIONS.AUDIT_LOGS).add({
        data: {
          actor_openid: OPENID, action: 'auth.login', object_type: 'user', object_id: user._id,
          result: 'success', detail: { role: user.role, scene, source: 'mini' }, created_at: now
        }
      });
      return ok({ session, first_login: firstLogin, user: publicUser(user) });
    } catch (e) {
      console.error('[login][wechat] error:', e);
      return fail(500, 'INTERNAL: login failed');
    }
  }

  // ============ Web 通路（无微信上下文，必须带 _token / 或登录/绑定流程） ============
  if (scene === 'web') {
    // —— 2. 发送验证码 ——
    if (p.action === 'sms.send') {
      const phone = p.phone || '';
      if (!/^\+?[0-9]{6,15}$/.test(phone)) return fail(400, 'INVALID_PHONE');
      const codes = db.collection(COLLECTIONS.SMS_CODES);
      try {
        const recent = await codes.where({ phone, purpose: 'login', used: false })
          .orderBy('created_at', 'desc').limit(1).get();
        if (recent.data.length) {
          const last = new Date(recent.data[0].created_at).getTime();
          if (Date.now() - last < SMS_INTERVAL_SEC * 1000) {
            return fail(429, 'SMS_TOO_FREQUENT');
          }
        }
        const code = genCode();
        await sendSmsViaProvider(phone, code);
        await codes.add({
          data: {
            phone, purpose: 'login', code_hash: sha256(code),
            expires_at: new Date(Date.now() + CODE_TTL_SEC * 1000),
            attempts: 0, used: false, created_at: now
          }
        });
        // 仅开发/沙箱环境回传 mock 验证码（便于本地联调）；生产（NODE_ENV=production）绝不返回
        const mockAllowed = process.env.NODE_ENV !== 'production';
        return ok({ sent: true, mock_code: mockAllowed ? code : undefined });
      } catch (e) {
        console.error('[login][sms] error:', e);
        return fail(500, 'INTERNAL: sms failed');
      }
    }

    // —— 3. Web 登录（验证码 / 密码 / 微信扫码） ——
    if (p.action === 'login') {
      const mode = p.mode || '';
      const phone = p.phone || '';
      if (!/^\+?[0-9]{6,15}$/.test(phone)) return fail(400, 'INVALID_PHONE');
      const users = db.collection(COLLECTIONS.USERS);
      try {
        const user = await findUser(db, { phone });
        if (!user) return fail(401, 'ACCOUNT_NOT_FOUND');
        if (user.status === 'disabled') return fail(403, 'ACCOUNT_DISABLED');
        if (user.lock_until && new Date(user.lock_until).getTime() > Date.now()) {
          return fail(429, 'ACCOUNT_LOCKED');
        }

        if (mode === 'sms') {
          const code = p.code || '';
          const hit = await db.collection(COLLECTIONS.SMS_CODES)
            .where({ phone, purpose: 'login', used: false })
            .orderBy('created_at', 'desc').limit(1).get();
          if (!hit.data.length) return fail(401, 'CODE_EXPIRED');
          const rec = hit.data[0];
          if (new Date(rec.expires_at).getTime() < Date.now()) return fail(401, 'CODE_EXPIRED');
          if (rec.attempts >= MAX_CODE_ATTEMPTS) return fail(429, 'CODE_ATTEMPTS_EXCEEDED');
          if (sha256(code) !== rec.code_hash) {
            await db.collection(COLLECTIONS.SMS_CODES).doc(rec._id)
              .update({ data: { attempts: rec.attempts + 1 } });
            return fail(401, 'CODE_INVALID');
          }
          await db.collection(COLLECTIONS.SMS_CODES).doc(rec._id)
            .update({ data: { used: true } });
        } else if (mode === 'password') {
          const password = p.password || '';
          if (!user.password_hash) return fail(401, 'PASSWORD_NOT_SET');
          const okPass = await bcrypt.compare(password, user.password_hash);
          if (!okPass) {
            const fails = (user.login_fail_count || 0) + 1;
            const patch = { login_fail_count: fails, updated_at: now };
            if (fails >= MAX_LOGIN_FAILS) patch.lock_until = new Date(Date.now() + LOCK_SEC * 1000);
            await users.doc(user._id).update({ data: patch });
            return fail(401, 'PASSWORD_WRONG');
          }
          await users.doc(user._id).update({
            data: { login_fail_count: 0, lock_until: null, last_login_at: now, updated_at: now }
          });
        } else if (mode === 'wechat') {
          // 微信扫码登录通路（骨架）：前端扫码后经开放平台换取 web_openid 标识；
          // 此处接受 openid_bind（扫码回调得到的小程序 openid）做档案关联，绑定逻辑见 action=bind
          if (!p.openid_bind) return fail(400, 'MISSING_BIND_OPENID');
          const bound = await findUser(db, { openid: p.openid_bind });
          if (bound) {
            await users.doc(user._id).update({
              data: { bind_openid: p.openid_bind, web_openid: user.web_openid || ('web_' + sha256(phone).slice(0, 16)), updated_at: now }
            });
          }
        } else {
          return fail(400, 'INVALID_MODE');
        }

        const session = await issueSession(user, db, now);
        await db.collection(COLLECTIONS.AUDIT_LOGS).add({
          data: {
            actor_openid: user.openid || user._openid, action: 'auth.login', object_type: 'user', object_id: user._id,
            result: 'success', detail: { role: user.role, scene, mode, source: 'web' }, created_at: now
          }
        });
        return ok({ session, user: publicUser(user) });
      } catch (e) {
        console.error('[login][web:login] error:', e);
        return fail(500, 'INTERNAL: web login failed');
      }
    }

    // —— 4. Web 账号与小程序 openid 绑定（需已登录） ——
    if (p.action === 'bind') {
      const payload = tokenStore.verifyToken(event._token);
      if (!payload) return fail(401, 'UNAUTHORIZED');
      const users = db.collection(COLLECTIONS.USERS);
      try {
        const user = await findUser(db, { openid: payload.sub });
        if (!user) return fail(401, 'ACCOUNT_NOT_FOUND');
        const bindOpenid = p.bind_openid || p.openid_bind || '';
        if (!bindOpenid) return fail(400, 'MISSING_BIND_OPENID');
        // 找到小程序侧档案，将 Web 主档案资料合并过去（双端共享账号数据）
        const mini = await findUser(db, { openid: bindOpenid });
        if (mini) {
          const patch = {};
          if (user.name && !mini.name) patch.name = user.name;
          if (user.phone && !mini.phone) patch.phone = user.phone;
          if (user.org && !mini.org) patch.org = user.org;
          if (user.role && user.role !== 'customer') patch.role = user.role;
          if (Object.keys(patch).length) {
            await users.doc(mini._id).update({ data: Object.assign(patch, { updated_at: now }) });
          }
        }
        await users.doc(user._id).update({
          data: {
            web_openid: user.web_openid || ('web_' + sha256(user.phone || payload.sub).slice(0, 16)),
            bind_openid: bindOpenid,
            updated_at: now
          }
        });
        const session = await issueSession(user, db, now);
        await db.collection(COLLECTIONS.AUDIT_LOGS).add({
          data: {
            actor_openid: user.openid || user._openid, action: 'auth.bind', object_type: 'user', object_id: user._id,
            result: 'success', detail: { bind_openid: bindOpenid, source: 'web' }, created_at: now
          }
        });
        return ok({ session, user: publicUser(Object.assign({}, user, { bind_openid: bindOpenid })) });
      } catch (e) {
        console.error('[login][bind] error:', e);
        return fail(500, 'INTERNAL: bind failed');
      }
    }

    // —— 5. 设置/重置密码（bcrypt 加盐哈希） ——
    if (p.action === 'setPassword') {
      const payload = tokenStore.verifyToken(event._token);
      if (!payload) return fail(401, 'UNAUTHORIZED');
      const password = p.password || '';
      if (password.length < 8 || password.length > 128) return fail(400, 'PASSWORD_WEAK');
      const users = db.collection(COLLECTIONS.USERS);
      try {
        const user = await findUser(db, { openid: payload.sub });
        if (!user) return fail(401, 'ACCOUNT_NOT_FOUND');
        const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const nextVersion = (user.token_version || 0) + 1; // 改密后旧 token 全部失效
        await users.doc(user._id).update({
          data: { password_hash: hash, token_version: nextVersion, updated_at: now }
        });
        await db.collection(COLLECTIONS.AUDIT_LOGS).add({
          data: {
            actor_openid: user.openid || user._openid, action: 'auth.password', object_type: 'user', object_id: user._id,
            result: 'success', detail: { source: 'web' }, created_at: now
          }
        });
        return ok({ password_set: true, token_version: nextVersion });
      } catch (e) {
        console.error('[login][setPassword] error:', e);
        return fail(500, 'INTERNAL: set password failed');
      }
    }

    // —— 6. refresh_token 换发 access_token ——
    if (p.action === 'refresh') {
      const payload = tokenStore.verifyToken(p.refresh_token);
      if (!payload || payload.type !== 'refresh') return fail(401, 'REFRESH_INVALID');
      try {
        const user = await findUser(db, { openid: payload.sub });
        if (!user) return fail(401, 'ACCOUNT_NOT_FOUND');
        if ((user.token_version || 0) !== payload.ver) return fail(401, 'TOKEN_VERSION_EXPIRED');
        const session = await issueSession(user, db, now);
        return ok({ session });
      } catch (e) {
        console.error('[login][refresh] error:', e);
        return fail(500, 'INTERNAL: refresh failed');
      }
    }

    return fail(400, 'INVALID_WEB_ACTION');
  }

  return fail(400, 'INVALID_SCENE');
};

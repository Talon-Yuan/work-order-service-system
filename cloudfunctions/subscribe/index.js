/**
 * subscribe 云函数 — 阶段 6-3：订阅消息体系
 *
 * 职责：
 *  - subscribe.templates：返回可订阅模板列表（6 类；template_id 从环境变量读取，前端零密钥）
 *  - subscribe.allow：用户授权登记（wx.requestSubscribeMessage 授权成功后上报模板类型）
 *  - subscribe.list：查询本人已授权订阅状态
 *  - subscribe.send：服务端发送订阅消息（内部密钥 或 admin；防伪造 + 模板白名单 + 授权校验 + 限流）
 *
 * 安全红线：
 *  - 模板 ID 仅存环境变量（SUB_TMPL_*），不硬编码密钥/模板ID；
 *  - subscribe.send 不向普通用户开放：必须带内部密钥（_internal_key == SUBSCRIBE_INTERNAL_KEY）
 *    或 admin 鉴权，防止伪造批量骚扰；
 *  - 只允许向已授权该模板的用户发送（一次性订阅需再次授权）；
 *  - 同用户同模板限流（5 分钟 1 条），日志脱敏 openid/数据。
 */
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./common/response');
const { ACTIONS, COLLECTIONS, SUB_TEMPLATE_TYPES } = require('./common/constants');
const { cleanInput, inEnum } = require('./common/security');
const { authGuard } = require('./common/authGuard');
const { writeAudit } = require('./common/workflow');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

/** 模板类型 → 环境变量名（template_id 仅存环境变量） */
const TMPL_ENV = {
  [SUB_TEMPLATE_TYPES.APPOINTMENT_APPROVED]: 'SUB_TMPL_APPOINTMENT_APPROVED',
  [SUB_TEMPLATE_TYPES.VISIT_REMINDER]: 'SUB_TMPL_VISIT_REMINDER',
  [SUB_TEMPLATE_TYPES.WORK_ORDER_PROGRESS]: 'SUB_TMPL_WORK_ORDER_PROGRESS',
  [SUB_TEMPLATE_TYPES.LOGISTICS_DYNAMIC]: 'SUB_TMPL_LOGISTICS_DYNAMIC',
  [SUB_TEMPLATE_TYPES.STOCK_ALERT]: 'SUB_TMPL_STOCK_ALERT',
  [SUB_TEMPLATE_TYPES.MAINTENANCE_REMINDER]: 'SUB_TMPL_MAINTENANCE_REMINDER'
};

/** 模板展示定义（name_key 供语言包 i18n） */
const TEMPLATE_META = [
  { template_type: SUB_TEMPLATE_TYPES.APPOINTMENT_APPROVED, name_key: 'subAppointmentApproved', desc_key: 'subAppointmentApprovedDesc' },
  { template_type: SUB_TEMPLATE_TYPES.VISIT_REMINDER, name_key: 'subVisitReminder', desc_key: 'subVisitReminderDesc' },
  { template_type: SUB_TEMPLATE_TYPES.WORK_ORDER_PROGRESS, name_key: 'subWorkOrderProgress', desc_key: 'subWorkOrderProgressDesc' },
  { template_type: SUB_TEMPLATE_TYPES.LOGISTICS_DYNAMIC, name_key: 'subLogisticsDynamic', desc_key: 'subLogisticsDynamicDesc' },
  { template_type: SUB_TEMPLATE_TYPES.STOCK_ALERT, name_key: 'subStockAlert', desc_key: 'subStockAlertDesc' },
  { template_type: SUB_TEMPLATE_TYPES.MAINTENANCE_REMINDER, name_key: 'subMaintenanceReminder', desc_key: 'subMaintenanceReminderDesc' }
];

/** 脱敏：openid 保留前 6 后 4 */
function maskOpenid(s) {
  if (!s) return '';
  return String(s).length > 12 ? String(s).slice(0, 6) + '****' + String(s).slice(-4) : '****';
}

exports.main = async (event) => {
  const action = event && event.action;
  if (action === ACTIONS.SUBSCRIBE_TEMPLATES) return templates(event);
  if (action === ACTIONS.SUBSCRIBE_ALLOW) return allow(event);
  if (action === ACTIONS.SUBSCRIBE_LIST) return list(event);
  if (action === ACTIONS.SUBSCRIBE_SEND) return send(event);
  return fail(400, 'UNKNOWN_ACTION');
};

/** 6-3a：可订阅模板列表（template_id 非密钥，前端需真实 ID 调 wx.requestSubscribeMessage） */
async function templates(event) {
  const ctx = await authGuard(event, { action: ACTIONS.SUBSCRIBE_TEMPLATES });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);

  const items = TEMPLATE_META.map((m) => ({
    template_type: m.template_type,
    name_key: m.name_key,
    desc_key: m.desc_key,
    template_id: process.env[TMPL_ENV[m.template_type]] || '',
    configured: !!process.env[TMPL_ENV[m.template_type]]
  }));
  return ok({ items });
}

/** 6-3b：用户授权登记（wx.requestSubscribeMessage 授权成功后上报已授权模板类型） */
async function allow(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      template_types: { type: 'array', required: true }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.SUBSCRIBE_ALLOW });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db: d, openid } = ctx;

  // 模板白名单：仅接受系统定义的 6 类模板
  const allowed = (p.template_types || []).filter((t) =>
    Object.values(SUB_TEMPLATE_TYPES).includes(t)
  );
  if (!allowed.length) return fail(400, 'NO_VALID_TEMPLATES');

  try {
    const now = new Date();
    const userRes = await d.collection(COLLECTIONS.USERS).where({ _openid: openid }).limit(1).get();
    const updates = {};
    for (const t of allowed) {
      updates['subscribe_templates.' + t] = now; // 记录授权时间（一次性授权）
    }
    if (userRes.data.length) {
      await d.collection(COLLECTIONS.USERS).doc(userRes.data[0]._id).update({
        data: Object.assign(updates, { updated_at: now })
      });
    } else {
      // 兜底：用户文档不存在时只登记授权（不额外创建完整档案）
      await d.collection(COLLECTIONS.USERS).add({
        data: { _openid: openid, subscribe_templates: allowed.reduce((m, t) => { m[t] = now; return m; }, {}), created_at: now, updated_at: now }
      });
    }
    await writeAudit(d, {
      actor_openid: openid, role: ctx.role, action: 'subscribe_allow',
      target_collection: COLLECTIONS.USERS, target_id: userRes.data.length ? userRes.data[0]._id : '',
      after: { template_types: allowed }
    });
    return ok({ granted: allowed.map((t) => ({ template_type: t, granted_at: now })) });
  } catch (e) {
    console.error('[subscribe] allow error:', e.message);
    return fail(500, 'INTERNAL: subscribe allow failed');
  }
}

/** 6-3c：查询本人已授权订阅状态 */
async function list(event) {
  const ctx = await authGuard(event, { action: ACTIONS.SUBSCRIBE_LIST });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db: d, openid } = ctx;

  try {
    const userRes = await d.collection(COLLECTIONS.USERS).where({ _openid: openid }).limit(1).get();
    const granted = (userRes.data[0] && userRes.data[0].subscribe_templates) || {};
    const items = TEMPLATE_META.map((m) => ({
      template_type: m.template_type,
      name_key: m.name_key,
      desc_key: m.desc_key,
      granted: !!granted[m.template_type],
      granted_at: granted[m.template_type] || null
    }));
    return ok({ items });
  } catch (e) {
    console.error('[subscribe] list error:', e.message);
    return fail(500, 'INTERNAL: subscribe list failed');
  }
}

/** 同用户同模板限流（5 分钟 1 条；本地窗口，云函数实例内近似） */
const sendBuckets = {};
function checkSendRate(openid, templateType) {
  const key = openid + '|' + templateType;
  const now = Date.now();
  const b = sendBuckets[key] || { last: 0 };
  if (now - b.last < 5 * 60 * 1000) return false;
  b.last = now;
  sendBuckets[key] = b;
  return true;
}

/** 6-3d：服务端发送订阅消息（内部密钥 / admin 两种合法路径） */
async function send(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      template_type: { type: 'string', max: 40, required: true },
      touser_openid: { type: 'string', max: 64, required: true },
      page: { type: 'string', max: 200, default: '' },
      data: { type: 'object', default: {} },
      miniprogram_state: { type: 'string', max: 20, default: 'formal' },
      _internal_key: { type: 'string', max: 128, default: '' }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  // 身份判定：① 内部密钥（云函数间服务端调用）② admin 管理端 token 鉴权
  const internalKey = process.env.SUBSCRIBE_INTERNAL_KEY;
  const isInternal = internalKey && p._internal_key && p._internal_key === internalKey;
  let ctx = null;
  if (!isInternal) {
    ctx = await authGuard(event, { action: ACTIONS.SUBSCRIBE_SEND });
    if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  }
  const actor = isInternal ? 'SYSTEM' : ctx.openid;
  const role = isInternal ? 'system' : ctx.role;

  // 模板白名单
  if (!inEnum(p.template_type, Object.values(SUB_TEMPLATE_TYPES))) {
    return fail(400, 'INVALID_TEMPLATE_TYPE');
  }
  const envKey = TMPL_ENV[p.template_type];
  const templateId = process.env[envKey];
  if (!templateId) return fail(409, 'TEMPLATE_NOT_CONFIGURED');

  try {
    const { db: d } = ctx || { db }; // 内部调用同样可用 db（管理权限）
    const userRes = await d.collection(COLLECTIONS.USERS).where({ _openid: p.touser_openid }).limit(1).get();
    const grantedMap = (userRes.data[0] && userRes.data[0].subscribe_templates) || {};
    if (!grantedMap[p.template_type]) {
      // 未授权该模板 → 明确返回（一次性订阅已过期也需重新授权）
      return fail(403, 'NOT_SUBSCRIBED');
    }
    if (!checkSendRate(p.touser_openid, p.template_type)) {
      return fail(429, 'RATE_LIMITED');
    }

    const sendData = {};
    for (const [k, v] of Object.entries(p.data || {})) {
      if (v && typeof v === 'object' && v.value !== undefined) {
        sendData[k] = v;
      }
    }
    if (!Object.keys(sendData).length) return fail(400, 'EMPTY_TEMPLATE_DATA');

    let sendRes;
    try {
      sendRes = await cloud.openapi.subscribeMessage.send({
        touser: p.touser_openid,
        page: p.page || undefined,
        templateId,
        data: sendData,
        miniprogramState: p.miniprogram_state || 'formal'
      });
    } catch (apiErr) {
      // 43001 用户拒绝 / 43101 用户拒收（一次性订阅失效）→ 业务级提示
      const errCode = apiErr && (apiErr.errCode || apiErr.errcode);
      await writeAudit(d, {
        actor_openid: actor, role, action: 'subscribe_send',
        target_collection: COLLECTIONS.USERS, target_id: userRes.data.length ? userRes.data[0]._id : '',
        before: { template_type: p.template_type },
        after: { result: 'api_error', errCode, touser: maskOpenid(p.touser_openid) }
      });
      if (errCode === 43001 || errCode === 43101) {
        return fail(403, 'SUBSCRIBE_REJECTED');
      }
      console.error('[subscribe] openapi send error:', errCode, apiErr && apiErr.errMsg);
      return fail(502, 'WECHAT_SEND_FAILED');
    }

    await writeAudit(d, {
      actor_openid: actor, role, action: 'subscribe_send',
      target_collection: COLLECTIONS.USERS, target_id: userRes.data.length ? userRes.data[0]._id : '',
      after: { template_type: p.template_type, msg_id: sendRes && sendRes.msgid, touser: maskOpenid(p.touser_openid) }
    });
    return ok({ msg_id: sendRes && sendRes.msgid, template_type: p.template_type });
  } catch (e) {
    console.error('[subscribe] send error:', e.message);
    return fail(500, 'INTERNAL: subscribe send failed');
  }
}

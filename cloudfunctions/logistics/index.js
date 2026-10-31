/**
 * logistics 云函数 — 阶段 6-1 / 6-2：物流追踪与订阅推送
 *
 * 职责：
 *  - logistics.create：发货创建物流单（waybills）+ 订阅快递100 轨迹推送（owner/admin）
 *  - logistics.trace：轨迹查询（客户本人/管理端，行级过滤 + 限流 + 日志脱敏）
 *  - logistics.list：物流单列表（客户本人/管理端）
 *  - logistics.callback：快递100 订阅回调（服务端验签，不走用户鉴权；6-2 状态与订单联动）
 *
 * 安全红线：
 *  - 密钥仅存环境变量（KUAIDI100_KEY / KUAIDI100_CUSTOMER / KUAIDI100_CALLBACK_URL），前端零密钥；
 *  - 回调必须验签（verifyCallbackSign），验签失败拒绝且不泄露业务细节；
 *  - 轨迹查询与回调全链路日志脱敏（logisticsClient.mask）；
 *  - 客户只能查自己订单关联的物流单（openid 行级隔离）。
 */
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./common/response');
const { ACTIONS, COLLECTIONS, LOGISTICS_STATUS, SUB_TEMPLATE_TYPES } = require('./common/constants');
const { cleanInput, inEnum } = require('./common/security');
const { authGuard } = require('./common/authGuard');
const { writeAudit, sendNotification } = require('./common/workflow');
const L = require('./common/logisticsClient');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

/** 每用户轨迹查询限流：60 秒窗口 20 次（防抓取与上游费用滥用） */
const TRACE_RATE = { windowMs: 60 * 1000, max: 20 };

exports.main = async (event) => {
  const action = event && event.action;
  if (action === ACTIONS.LOGISTICS_CREATE) return create(event);
  if (action === ACTIONS.LOGISTICS_TRACE) return trace(event);
  if (action === ACTIONS.LOGISTICS_LIST) return list(event);
  if (action === ACTIONS.LOGISTICS_CALLBACK) return callback(event);
  return fail(400, 'UNKNOWN_ACTION');
};

/** 6-1a：创建物流单 + 订阅轨迹推送 */
async function create(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      order_id: { type: 'string', max: 64, required: true },
      carrier: { type: 'string', max: 20, required: true },      // 快递100 公司编码 com
      tracking_no: { type: 'string', max: 64, required: true },  // 运单号
      carrier_name: { type: 'string', max: 40, default: '' },    // 展示名（如 顺丰速运）
      phone: { type: 'string', max: 20, default: '' }            // 收件人手机（订阅推送用，脱敏存储）
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.LOGISTICS_CREATE });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db: d, openid, role } = ctx;

  try {
    // 订单必须已发货（shipped）——发货动作由 order.ship 完成出库与状态变更
    const orderRes = await d.collection(COLLECTIONS.ORDERS).doc(p.order_id).get();
    if (!orderRes.data) return fail(404, 'ORDER_NOT_FOUND');
    const order = orderRes.data;
    if (order.status !== 'shipped') {
      return fail(409, 'ORDER_NOT_SHIPPED');
    }

    // 幂等：同订单已有物流单则直接返回
    const dup = await d.collection(COLLECTIONS.WAYBILLS)
      .where({ order_id: p.order_id }).limit(1).get();
    if (dup.data.length) {
      return ok({ waybill_id: dup.data[0]._id, existed: true });
    }

    const now = new Date();
    const waybill = {
      order_id: p.order_id,
      order_no: order.order_no || '',
      customer_openid: order._openid || '',
      carrier: p.carrier,
      carrier_name: p.carrier_name || p.carrier,
      tracking_no: p.tracking_no,
      status: LOGISTICS_STATUS.PENDING,
      raw_trace: [],
      subscribed: false,
      subscribe_error: '',
      created_at: now,
      updated_at: now
    };
    const addRes = await d.collection(COLLECTIONS.WAYBILLS).add({ data: waybill });

    // 补订单物流号（若未填）
    if (!order.logistics_no) {
      await d.collection(COLLECTIONS.ORDERS).doc(p.order_id).update({
        data: { logistics_no: p.tracking_no, updated_at: now }
      });
    }

    // 订阅快递100 轨迹推送（密钥未配置时明确报错，不静默降级）
    let subscribed = false;
    let subscribe_error = '';
    const subRes = await L.subscribeTrace({ carrier: p.carrier, tracking_no: p.tracking_no, phone: p.phone });
    if (subRes.ok) {
      subscribed = true;
    } else {
      subscribe_error = subRes.message; // 脱敏信息（不含密钥）
      await d.collection(COLLECTIONS.WAYBILLS).doc(addRes._id).update({
        data: { subscribed: false, subscribe_error, updated_at: now }
      });
      if (subRes.message === 'LOGISTICS_NOT_CONFIGURED') {
        // waybill 已创建，返回明确提示供管理员配置后重试订阅
        await writeAudit(d, {
          actor_openid: openid, role, action: 'logistics_create',
          target_collection: COLLECTIONS.WAYBILLS, target_id: addRes._id,
          after: { order_id: p.order_id, tracking_no: L.mask(p.tracking_no), subscribed: false,
                   note: 'subscribe skipped: LOGISTICS_NOT_CONFIGURED' }
        });
        return ok({
          waybill_id: addRes._id,
          status: waybill.status,
          subscribed: false,
          warning: 'LOGISTICS_NOT_CONFIGURED',
          hint: '请配置 KUAIDI100_KEY/KUAIDI100_CUSTOMER/KUAIDI100_CALLBACK_URL 后重试订阅'
        });
      }
    }
    await d.collection(COLLECTIONS.WAYBILLS).doc(addRes._id).update({
      data: { subscribed, updated_at: now }
    });

    // 审计 + 站内通知客户
    await writeAudit(d, {
      actor_openid: openid, role, action: 'logistics_create',
      target_collection: COLLECTIONS.WAYBILLS, target_id: addRes._id,
      after: { order_id: p.order_id, tracking_no: L.mask(p.tracking_no), carrier: p.carrier, subscribed }
    });
    if (waybill.customer_openid) {
      await sendNotification(d, {
        receiver_openid: waybill.customer_openid, type: 'logistics',
        title: '订单已发货',
        content: '订单 ' + (order.order_no || p.order_id) + ' 已发货，运单号 ' + L.mask(p.tracking_no) + '，可查看物流追踪。',
        ref_type: 'order', ref_id: p.order_id
      });
    }
    return ok({ waybill_id: addRes._id, status: waybill.status, subscribed });
  } catch (e) {
    console.error('[logistics] create error:', e.message);
    return fail(500, 'INTERNAL: logistics create failed');
  }
}

/** 行级过滤：客户只能查本人订单物流；owner/admin 全量 */
function waybillRowFilter(ctx) {
  if (ctx.role === 'customer') return { customer_openid: ctx.openid };
  return {};
}

/** 6-1b：轨迹查询（客户本人/管理端；限流 + 行级隔离 + 脱敏） */
async function trace(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      waybill_id: { type: 'string', max: 64 },
      order_id: { type: 'string', max: 64 }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }
  if (!p.waybill_id && !p.order_id) return fail(400, 'INVALID_PARAMS');

  const ctx = await authGuard(event, { action: ACTIONS.LOGISTICS_TRACE });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db: d, openid, role } = ctx;

  try {
    const rl = await checkRateLimitFor(openid);
    if (!rl.ok) return fail(429, rl.msg);

    let waybill = null;
    if (p.waybill_id) {
      const res = await d.collection(COLLECTIONS.WAYBILLS)
        .where(Object.assign({}, waybillRowFilter(ctx), { _id: p.waybill_id })).limit(1).get();
      waybill = res.data[0] || null;
    } else {
      const res = await d.collection(COLLECTIONS.WAYBILLS)
        .where(Object.assign({}, waybillRowFilter(ctx), { order_id: p.order_id })).limit(1).get();
      waybill = res.data[0] || null;
    }
    if (!waybill) return fail(404, 'WAYBILL_NOT_FOUND');

    // 本地轨迹为空或超过 15 分钟未刷新 → 尝试向快递100 拉取最新轨迹
    let upstream = false;
    let warned = false;
    const stale = !waybill.raw_trace || waybill.raw_trace.length === 0 ||
      (new Date() - new Date(waybill.updated_at)) > 15 * 60 * 1000;
    if (stale) {
      const qr = await L.queryTrace({ carrier: waybill.carrier, tracking_no: waybill.tracking_no });
      if (qr.ok && qr.data && qr.data.data) {
        const merged = L.mergeTrace(waybill.raw_trace, qr.data.data);
        const std = L.mapState(qr.data.state);
        upstream = true;
        await d.collection(COLLECTIONS.WAYBILLS).doc(waybill._id).update({
          data: { raw_trace: merged, status: std, updated_at: new Date() }
        });
        waybill.raw_trace = merged;
        waybill.status = std;
        // 签收联动订单（6-2：签收 → 订单 completed）
        if (std === LOGISTICS_STATUS.DELIVERED) {
          await completeOrderIfShipped(d, waybill, openid, role);
        }
      } else if (qr.message === 'LOGISTICS_NOT_CONFIGURED') {
        warned = true;
      }
    }

    await writeAudit(d, {
      actor_openid: openid, role, action: 'logistics_trace',
      target_collection: COLLECTIONS.WAYBILLS, target_id: waybill._id,
      after: { tracking_no: L.mask(waybill.tracking_no), status: waybill.status, upstream }
    });

    const traceList = (waybill.raw_trace || []).map((t) => ({
      time: t.time, desc: t.desc, status: t.standard_status || t.status || waybill.status
    }));
    return ok({
      waybill: {
        waybill_id: waybill._id,
        order_id: waybill.order_id,
        carrier: waybill.carrier,
        carrier_name: waybill.carrier_name,
        tracking_no: waybill.tracking_no,
        status: waybill.status,
        subscribed: waybill.subscribed,
        updated_at: waybill.updated_at
      },
      trace: traceList,
      upstream_refreshed: upstream,
      warned_not_configured: warned
    });
  } catch (e) {
    console.error('[logistics] trace error:', e.message);
    return fail(500, 'INTERNAL: logistics trace failed');
  }
}

/** 6-1c：物流单列表（客户本人/管理端） */
async function list(event) {
  const ctx = await authGuard(event, { action: ACTIONS.LOGISTICS_LIST });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db: d, openid, role } = ctx;

  try {
    const res = await d.collection(COLLECTIONS.WAYBILLS)
      .where(waybillRowFilter(ctx))
      .orderBy('updated_at', 'desc')
      .limit(20)
      .get();
    const items = (res.data || []).map((w) => ({
      waybill_id: w._id,
      order_id: w.order_id,
      order_no: w.order_no || '',
      carrier_name: w.carrier_name,
      tracking_no: L.mask(w.tracking_no),
      status: w.status,
      subscribed: w.subscribed,
      updated_at: w.updated_at,
      last_trace: (w.raw_trace && w.raw_trace.length) ? w.raw_trace[w.raw_trace.length - 1].desc : ''
    }));
    return ok({ items });
  } catch (e) {
    console.error('[logistics] list error:', e.message);
    return fail(500, 'INTERNAL: logistics list failed');
  }
}

/** 6-2：签收联动订单 shipped → completed（自动确认收货） */
async function completeOrderIfShipped(d, waybill, openid, role) {
  try {
    const orderRes = await d.collection(COLLECTIONS.ORDERS).doc(waybill.order_id).get();
    if (!orderRes.data) return;
    const order = orderRes.data;
    if (order.status !== 'shipped') return; // 仅 shipped → completed
    await d.collection(COLLECTIONS.ORDERS).doc(waybill.order_id).update({
      data: { status: 'completed', completed_at: new Date(), updated_at: new Date() }
    });
    await writeAudit(d, {
      actor_openid: openid, role, action: 'order_completed_by_logistics',
      target_collection: COLLECTIONS.ORDERS, target_id: waybill.order_id,
      before: { status: 'shipped' }, after: { status: 'completed', waybill_id: waybill._id }
    });
    if (waybill.customer_openid) {
      await sendNotification(d, {
        receiver_openid: waybill.customer_openid, type: 'logistics',
        title: '订单已签收',
        content: '运单号 ' + L.mask(waybill.tracking_no) + ' 已签收，订单自动完成。',
        ref_type: 'order', ref_id: waybill.order_id
      });
    }
  } catch (e) {
    console.error('[logistics] completeOrderIfShipped error:', e.message);
  }
}

/** 6-2b：快递100 订阅回调（服务端验签；不校验用户身份） */
async function callback(event) {
  // 快递100 回调：POST 表单 body 为 JSON 字符串，参数 sign/customer 在 query/body 中
  // 兼容两种传参方式：event.body（原始 JSON 串）或 event.param（对象化）
  let body = '';
  let sign = '';
  if (typeof event.body === 'string') {
    body = event.body;
    sign = event.sign || (event.queryStringParameters && event.queryStringParameters.sign) || '';
  } else if (event.param && typeof event.param === 'object') {
    body = JSON.stringify(event.param);
    sign = event.sign || '';
  } else if (typeof event === 'string') {
    body = event;
  }
  if (!body) return fail(400, 'INVALID_CALLBACK_BODY');

  try {
    // 验签（密钥缺失时明确拒绝）
    if (!L.verifyCallbackSign(body, sign)) {
      console.warn('[logistics] callback sign verify failed:', L.mask(body).slice(0, 200));
      return fail(401, 'SIGN_VERIFY_FAILED');
    }

    let payload;
    try { payload = JSON.parse(body); } catch (e) { return fail(400, 'BAD_CALLBACK_JSON'); }
    const trackingNo = payload.lastResult && payload.lastResult.nu;
    const carrier = payload.lastResult && payload.lastResult.com;
    if (!trackingNo || !carrier) return fail(400, 'BAD_CALLBACK_FIELDS');

    const d = db; // 云函数身份（管理权限）写入，回调不走用户鉴权
    const res = await d.collection(COLLECTIONS.WAYBILLS)
      .where({ tracking_no: trackingNo, carrier }).limit(1).get();
    if (!res.data.length) {
      // 未找到运单（或已删除）→ 返回 200 防止探测与无谓重试
      return ok({ result: true, returnCode: '200', note: 'waybill_not_found' });
    }
    const waybill = res.data[0];
    const incoming = (payload.lastResult && payload.lastResult.data) || [];
    const merged = L.mergeTrace(waybill.raw_trace, incoming);
    const std = L.mapState(payload.lastResult.state);

    const changed = std !== waybill.status || merged.length !== (waybill.raw_trace || []).length;
    await d.collection(COLLECTIONS.WAYBILLS).doc(waybill._id).update({
      data: { raw_trace: merged, status: std, updated_at: new Date() }
    });

    if (std === LOGISTICS_STATUS.DELIVERED) {
      await completeOrderIfShipped(d, waybill, 'SYSTEM', 'system');
    }

    // 发送订阅消息（物流动态模板）——内部密钥调用 subscribe 云函数；失败不阻塞回调
    if (waybill.customer_openid && changed) {
      await sendNotification(d, {
        receiver_openid: waybill.customer_openid, type: 'logistics',
        title: '物流动态更新',
        content: '运单 ' + L.mask(waybill.tracking_no) + ' 最新状态：' + std,
        ref_type: 'order', ref_id: waybill.order_id
      });
      await trySendSubscribeMessage({
        template_type: SUB_TEMPLATE_TYPES.LOGISTICS_DYNAMIC,
        touser_openid: waybill.customer_openid,
        page: 'pages/logistics/index?waybill_id=' + waybill._id,
        data: {
          thing1: { value: '物流状态更新' },
          phrase1: { value: std === 'delivered' ? '已签收' : std === 'in_transit' ? '运输中' : std === 'exception' ? '异常' : '待更新' },
          character_string1: { value: (waybill.tracking_no || '').slice(0, 32) }
        }
      });
    }

    await writeAudit(d, {
      actor_openid: 'SYSTEM', role: 'system', action: 'logistics_callback',
      target_collection: COLLECTIONS.WAYBILLS, target_id: waybill._id,
      before: { status: waybill.status }, after: { status: std, trace_count: merged.length }
    });

    return ok({ result: true, returnCode: '200' });
  } catch (e) {
    console.error('[logistics] callback error:', e.message);
    return fail(500, 'INTERNAL: callback failed');
  }
}

/** 服务端发送订阅消息（调用 subscribe 云函数，内部密钥） */
async function trySendSubscribeMessage(msg) {
  try {
    const key = process.env.SUBSCRIBE_INTERNAL_KEY;
    if (!key) return; // 未配置内部密钥：跳过订阅推送（站内通知仍生效）
    await cloud.callFunction({
      name: 'subscribe',
      data: Object.assign({ action: 'subscribe.send', _internal_key: key }, msg)
    });
  } catch (e) {
    console.error('[logistics] send subscribe message error:', e.message);
  }
}

/** 轨迹查询限流（本地计数窗口） */
const rateBuckets = {};
async function checkRateLimitFor(openid) {
  const now = Date.now();
  const b = rateBuckets[openid] || { count: 0, windowStart: now };
  if (now - b.windowStart >= TRACE_RATE.windowMs) {
    b.count = 0; b.windowStart = now;
  }
  if (b.count >= TRACE_RATE.max) {
    return { ok: false, msg: 'RATE_LIMITED' };
  }
  b.count += 1;
  rateBuckets[openid] = b;
  return { ok: true };
}

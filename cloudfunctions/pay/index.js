/**
 * pay 云函数 — 微信支付 API v3（阶段 4：任务 4-4）
 *
 * 动作码：
 *   pay.create    统一下单（JSAPI）→ 返回小程序 wx.requestPayment 参数
 *   pay.query     主动查单（5/30/120/1440 分钟补单时由定时器调用；也支持手动查）
 *   pay.callback  支付回调（微信服务器 → 云函数 HTTPS 触发）
 *
 * 安全红线：
 *   - 商户号 / APIv3 密钥 / 商户私钥 / 平台证书 / 回调 URL 全部来自云函数环境变量；
 *     前端零密钥、代码零密钥字面量；未配置时返回 PAY_NOT_CONFIGURED 并指引 env-template.md。
 *
 * 回调校验顺序（严格）：
 *   1) 报文头完整性（Wechatpay-Signature / Timestamp / Nonce 缺失 → 非 2xx）
 *   2) 时间窗校验（|now - timestamp| > 300s → 拒绝，防重放）
 *   3) 平台证书 RSA-SHA256 验签（验签失败 → 非 2xx）
 *   4) AES-256-GCM 解密 resource
 *   5) nonce 去重（payment_flows.nonce 唯一索引，重复回调 → 幂等返回 200）
 *   6) 订单状态机幂等（订单已 paid 且金额一致 → 直接 200；金额不一致 → 拒绝）
 *   7) 事务更新订单 + 支付流水
 *   8) 返回 HTTP 200 与 { code: 'SUCCESS' }
 *
 * T+1 对账：scripts/stock_reconcile.py 提供支付流水与微信侧对账说明（见 docs/deploy.md）。
 */
const { ok, fail } = require('./common/response');
const { ACTIONS, COLLECTIONS } = require('./common/constants');
const { cleanInput } = require('./common/security');
const { authGuard } = require('./common/authGuard');
const { withTransaction } = require('./common/inventoryOps');
const wechatPay = require('./common/wechatPay');

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const action = event && event.action;
  switch (action) {
    case ACTIONS.PAY_CREATE: return handlePayCreate(event);
    case ACTIONS.PAY_QUERY: return handlePayQuery(event);
    case ACTIONS.PAY_CALLBACK: return handlePayCallback(event);
    default: return fail(400, 'UNKNOWN_ACTION');
  }
};

function requirePayConfig() {
  const { ok: ready, cfg, missing } = wechatPay.getPayConfig();
  if (!ready) {
    const err = new Error('PAY_NOT_CONFIGURED');
    err.missing = missing;
    throw err;
  }
  return cfg;
}

/** 统一下单：订单必须存在且属于当前用户且 status=pending */
async function handlePayCreate(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      order_id: { type: 'string', max: 64, required: true }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.PAY_CREATE });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);

  let cfg;
  try { cfg = requirePayConfig(); }
  catch (e) {
    return fail(503, 'PAY_NOT_CONFIGURED', {
      hint: '请在云函数环境变量中配置 PAY_MCH_ID / PAY_APP_ID / PAY_API_V3_KEY / PAY_MCH_SERIAL_NO / PAY_MCH_PRIVATE_KEY_PEM / PAY_PLATFORM_CERT_PEM / PAY_NOTIFY_URL，清单见 docs/env-template.md',
      missing: e.missing
    });
  }

  try {
    const orderRes = await db.collection(COLLECTIONS.ORDERS).doc(p.order_id).get();
    const order = orderRes.data;
    if (!order) return fail(404, 'ORDER_NOT_FOUND');
    if (order._openid !== ctx.openid && ctx.role !== 'admin' && ctx.role !== 'owner') {
      return fail(403, 'FORBIDDEN');
    }
    if (order.status !== 'pending') return fail(409, 'INVALID_STATUS_TRANSITION');

    const openid = (order.web_openid || ctx.session && ctx.session.web_openid || ctx.openid);
    const created = await wechatPay.createJsapiOrder(cfg, {
      outTradeNo: order.order_no,
      description: `备件商城订单 ${order.order_no}`.slice(0, 127),
      totalFen: order.total_fen,
      openid
    });
    const payParams = wechatPay.buildJsapiPayParams(cfg, created.prepay_id);
    return ok({ ...payParams, order_no: order.order_no });
  } catch (e) {
    console.error('[pay] create error:', e);
    if (e.message === 'WECHAT_PAY_API_ERROR') {
      return fail(502, 'WECHAT_PAY_API_ERROR', { status: e.status, detail: e.detail && e.detail.message });
    }
    return fail(500, 'INTERNAL: pay create failed');
  }
}

/**
 * 主动查单：微信侧 SUCCESS → 走与回调相同的幂等入账逻辑。
 * 补单策略：定时触发器在支付后 5 / 30 / 120 / 1440 分钟各调用一次 PAY_QUERY，
 * 已入账订单直接返回当前状态，不重复写。
 */
async function handlePayQuery(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      order_id: { type: 'string', max: 64, required: true }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.PAY_QUERY });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);

  let cfg;
  try { cfg = requirePayConfig(); }
  catch (e) {
    return fail(503, 'PAY_NOT_CONFIGURED', { hint: '支付环境变量未配置，见 docs/env-template.md', missing: e.missing });
  }

  try {
    const orderRes = await db.collection(COLLECTIONS.ORDERS).doc(p.order_id).get();
    const order = orderRes.data;
    if (!order) return fail(404, 'ORDER_NOT_FOUND');

    // 已入账订单幂等返回，不重复查微信
    if (order.status !== 'pending') {
      return ok({ order_id: p.order_id, order_no: order.order_no, status: order.status, pay_status: order.pay_status, already_settled: true });
    }

    const wxRes = await wechatPay.queryOrderByOutTradeNo(cfg, order.order_no);
    if (wxRes.__status !== 200 || !wxRes.trade_state) {
      return fail(502, 'WECHAT_PAY_QUERY_ERROR', { status: wxRes.__status });
    }
    if (wxRes.trade_state === 'SUCCESS') {
      const mockEvent = {
        action: ACTIONS.PAY_CALLBACK,
        body: wxRes.raw || null,
        headers: {},
        _mode: 'query_settle'
      };
      const settled = await settlePaidOrder(order, {
        transaction_id: wxRes.transaction_id,
        amountFen: wxRes.amount && wxRes.amount.total,
        nonce: 'query:' + wxRes.transaction_id
      });
      if (!settled.ok) return fail(settled.code || 500, settled.msg || 'SETTLE_FAILED');
      return ok({ order_id: p.order_id, order_no: order.order_no, status: 'paid', trade_state: 'SUCCESS' });
    }
    return ok({
      order_id: p.order_id,
      order_no: order.order_no,
      status: order.status,
      trade_state: wxRes.trade_state,
      retry_after_minutes: scheduleHint(wxRes.trade_state)
    });
  } catch (e) {
    console.error('[pay] query error:', e);
    if (e.message === 'WECHAT_PAY_API_ERROR') return fail(502, 'WECHAT_PAY_API_ERROR', { status: e.status, detail: e.detail && e.detail.message });
    return fail(500, 'INTERNAL: pay query failed');
  }
}

/** 补单时间建议（5/30/120/1440 分钟策略的映射） */
function scheduleHint(tradeState) {
  switch (tradeState) {
    case 'NOTPAY': return 5;
    case 'USERPAYING': return 30;
    case 'PAYERROR': return 120;
    default: return 1440;
  }
}

/**
 * 支付回调入口。
 * event.headers 由 HTTPS 触发网关透传微信支付回调头（Wechatpay-*）。
 * 验签/解密失败一律返回非 2xx（HTTP 网关会转成响应码）。
 */
async function handlePayCallback(event) {
  let cfg;
  try { cfg = requirePayConfig(); }
  catch (e) {
    return { statusCode: 503, body: JSON.stringify({ code: 'FAIL', message: 'PAY_NOT_CONFIGURED' }) };
  }

  const headers = (event && event.headers) || {};
  const rawBody = (event && event.body) || '';
  if (!rawBody) {
    return { statusCode: 400, body: JSON.stringify({ code: 'FAIL', message: 'EMPTY_BODY' }) };
  }

  // 1) 报文头完整性
  const sig = headers['wechatpay-signature'] || headers['Wechatpay-Signature'];
  const ts = headers['wechatpay-timestamp'] || headers['Wechatpay-Timestamp'];
  const nonce = headers['wechatpay-nonce'] || headers['Wechatpay-Nonce'];
  if (!sig || !ts || !nonce) {
    return { statusCode: 400, body: JSON.stringify({ code: 'FAIL', message: 'MISSING_HEADER' }) };
  }

  // 2) 时间窗（≤5 分钟）
  const tsSec = Number(ts);
  if (!Number.isFinite(tsSec) || Math.abs(Date.now() / 1000 - tsSec) > 300) {
    return { statusCode: 400, body: JSON.stringify({ code: 'FAIL', message: 'TIMESTAMP_WINDOW' }) };
  }

  // 3) 平台证书验签
  const verify = wechatPay.verifyCallbackSignature(cfg, headers, rawBody);
  if (!verify.ok) {
    return { statusCode: 401, body: JSON.stringify({ code: 'FAIL', message: 'SIGNATURE_INVALID', reason: verify.reason }) };
  }

  // 4) 解密
  let payload;
  try {
    const parsed = JSON.parse(rawBody);
    payload = wechatPay.decryptResource(cfg.apiV3Key, parsed.resource);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ code: 'FAIL', message: 'DECRYPT_ERROR' }) };
  }

  // 5) nonce 去重 + 6) 订单状态机幂等 + 7) 事务入账
  const outTradeNo = payload.out_trade_no;
  const orderRes = await db.collection(COLLECTIONS.ORDERS).where({ order_no: outTradeNo }).limit(1).get();
  const order = orderRes.data && orderRes.data[0];
  if (!order) {
    return { statusCode: 404, body: JSON.stringify({ code: 'FAIL', message: 'ORDER_NOT_FOUND' }) };
  }

  const settled = await settlePaidOrder(order, {
    transaction_id: payload.transaction_id,
    amountFen: payload.amount && payload.amount.total,
    nonce: payload.nonce_str || 'cb:' + payload.transaction_id,
    paid_at: Math.floor((payload.success_time ? new Date(payload.success_time).getTime() : Date.now()) / 1000)
  });
  if (!settled.ok) {
    return { statusCode: settled.code || 500, body: JSON.stringify({ code: 'FAIL', message: settled.msg || 'SETTLE_FAILED' }) };
  }

  // 8) 返回 200
  return { statusCode: 200, body: JSON.stringify({ code: 'SUCCESS', message: '成功' }) };
}

/**
 * 幂等入账（回调与查单共用）：
 *   - 已在 payment_flows 中登记该 transaction_id / nonce → 幂等成功；
 *   - 订单已 paid 且金额一致 → 幂等成功；金额不一致 → 拒绝；
 *   - 订单非 pending → 按状态返回（已入账幂等 / 非法拒绝）。
 */
async function settlePaidOrder(order, info) {
  try {
    const result = await withTransaction(db, async (tx) => {
      // 重复回调：同 transaction_id 已入账 → 幂等成功
      const dupRes = await tx.collection(COLLECTIONS.PAYMENT_FLOWS)
        .where({ transaction_id: info.transaction_id }).limit(1).get();
      if (dupRes.data && dupRes.data.length) {
        return { ok: true, duplicated: true };
      }
      // nonce 去重
      if (info.nonce) {
        const nonceRes = await tx.collection(COLLECTIONS.PAYMENT_FLOWS)
          .where({ nonce: info.nonce }).limit(1).get();
        if (nonceRes.data && nonceRes.data.length) {
          return { ok: true, duplicated: true };
        }
      }

      const cur = await tx.collection(COLLECTIONS.ORDERS).doc(order._id).get();
      const curOrder = cur.data;
      if (!curOrder) throw new Error('ORDER_NOT_FOUND');

      if (curOrder.status === 'paid') {
        if (curOrder.paid_fen === info.amountFen) return { ok: true, duplicated: true };
        throw new Error('AMOUNT_MISMATCH');
      }
      if (curOrder.status !== 'pending') throw new Error('INVALID_STATUS_TRANSITION');
      if (info.amountFen !== undefined && curOrder.total_fen !== info.amountFen) {
        throw new Error('AMOUNT_MISMATCH');
      }

      // 事务更新订单 + 支付流水
      await tx.collection(COLLECTIONS.ORDERS).doc(order._id).update({
        data: {
          status: 'paid',
          pay_status: 'paid',
          paid_fen: info.amountFen || curOrder.total_fen,
          transaction_id: info.transaction_id,
          paid_at: info.paid_at || Math.floor(Date.now() / 1000),
          updated_at: Date.now()
        }
      });
      await tx.collection(COLLECTIONS.PAYMENT_FLOWS).add({
        data: {
          order_id: order._id,
          order_no: order.order_no,
          _openid: order._openid,
          transaction_id: info.transaction_id,
          nonce: info.nonce || '',
          amount_fen: info.amountFen || curOrder.total_fen,
          trade_state: 'SUCCESS',
          source: info.source || 'callback',
          created_at: Date.now()
        }
      });
      return { ok: true, duplicated: false };
    }, 3);
    return result;
  } catch (e) {
    console.error('[pay] settle error:', e);
    if (e.message === 'AMOUNT_MISMATCH') return { ok: false, code: 409, msg: 'AMOUNT_MISMATCH' };
    if (e.message === 'INVALID_STATUS_TRANSITION') return { ok: false, code: 409, msg: 'INVALID_STATUS_TRANSITION' };
    if (e.message === 'ORDER_NOT_FOUND') return { ok: false, code: 404, msg: 'ORDER_NOT_FOUND' };
    return { ok: false, code: 500, msg: 'SETTLE_FAILED' };
  }
}

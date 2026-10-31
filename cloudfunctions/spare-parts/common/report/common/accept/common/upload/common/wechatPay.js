/**
 * wechatPay.js — 微信支付 API v3 客户端（阶段 4：微信支付）
 * 仅供 pay 云函数使用。
 *
 * 安全红线：
 *   - 商户号 / APIv3 密钥 / 商户私钥 / 微信支付平台证书 一律来自云函数环境变量，
 *     前端零密钥、代码零密钥字面量；
 *   - 未配置环境变量时返回 PAY_NOT_CONFIGURED 并指引 env-template.md，不静默降级。
 *
 * 职责：
 *   - 统一下单（JSAPI）并生成小程序 wx.requestPayment 所需参数
 *   - 主动查单（out-trade-no）
 *   - 回调验签（RSA-SHA256 + 平台证书）
 *   - 回调报文 AES-256-GCM 解密
 */
const crypto = require('crypto');
const https = require('https');

const PAY_HOST = 'api.mch.weixin.qq.com';

/**
 * 读取支付配置（全部来自环境变量）。返回 { ok, cfg, missing }
 */
function getPayConfig() {
  const cfg = {
    mchId: process.env.PAY_MCH_ID,               // 微信支付商户号
    appId: process.env.PAY_APP_ID,               // 小程序 AppID（与支付绑定）
    apiV3Key: process.env.PAY_API_V3_KEY,        // APIv3 密钥（32 字节）
    mchSerialNo: process.env.PAY_MCH_SERIAL_NO,  // 商户证书序列号
    mchPrivateKeyPem: process.env.PAY_MCH_PRIVATE_KEY_PEM, // 商户 API 私钥 PEM
    platformCertPem: process.env.PAY_PLATFORM_CERT_PEM,   // 微信支付平台证书 PEM（验签）
    notifyUrl: process.env.PAY_NOTIFY_URL        // 支付回调 URL（云函数 HTTPS 触发地址）
  };
  const missing = Object.keys(cfg).filter((k) => !cfg[k]);
  return { ok: missing.length === 0, cfg, missing };
}

/** 构造验签原文：method\nurlPath\ntimestamp\nnonce\nbody\n */
function buildSignStr(method, urlPath, timestamp, nonce, body) {
  return `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${body || ''}\n`;
}

/** 使用商户私钥做 SHA256-RSA 签名，返回 Base64 签名 */
function signWithPrivateKey(pem, content) {
  const key = crypto.createPrivateKey(pem);
  return crypto.sign('RSA-SHA256', Buffer.from(content, 'utf8'), key).toString('base64');
}

/** 生成 API v3 Authorization 头 */
function buildAuthHeader(cfg, method, urlPath, body) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const signStr = buildSignStr(method, urlPath, timestamp, nonce, body);
  const signature = signWithPrivateKey(cfg.mchPrivateKeyPem, signStr);
  return (
    `WECHATPAY2-SHA256-RSA2048 ` +
    `mchid="${cfg.mchId}",nonce_str="${nonce}",signature="${signature}",` +
    `timestamp="${timestamp}",serial_no="${cfg.mchSerialNo}"`
  );
}

/** HTTPS 请求微信支付 API v3（仅支持 JSON GET/POST，返回解析后的对象） */
function requestWechatPay(method, urlPath, cfg, bodyObj) {
  const body = bodyObj === undefined || bodyObj === null ? '' : JSON.stringify(bodyObj);
  const auth = buildAuthHeader(cfg, method, urlPath, body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: PAY_HOST,
        path: urlPath,
        method,
        headers: {
          Authorization: auth,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'wechat-pay-apiv3/cloudbase'
        }
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = raw ? JSON.parse(raw) : {}; } catch (e) { json = { raw }; }
          json.__status = res.statusCode;
          resolve(json);
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 统一下单（JSAPI），返回 prepay_id
 * @returns {{prepay_id: string}}
 */
async function createJsapiOrder(cfg, { outTradeNo, description, totalFen, openid }) {
  const body = {
    appid: cfg.appId,
    mchid: cfg.mchId,
    description,
    out_trade_no: outTradeNo,
    notify_url: cfg.notifyUrl,
    amount: { total: totalFen, currency: 'CNY' },
    payer: { openid }
  };
  const res = await requestWechatPay('POST', '/v3/pay/transactions/jsapi', cfg, body);
  if (res.__status !== 200 || !res.prepay_id) {
    const err = new Error('WECHAT_PAY_API_ERROR');
    err.status = res.__status;
    err.detail = res;
    throw err;
  }
  return { prepay_id: res.prepay_id };
}

/** 构造小程序 wx.requestPayment 所需参数（signType=RSA） */
function buildJsapiPayParams(cfg, prepayId) {
  const timeStamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = crypto.randomBytes(16).toString('hex');
  const pkg = `prepay_id=${prepayId}`;
  const signStr = `${cfg.appId}\n${timeStamp}\n${nonceStr}\n${pkg}\n`;
  const paySign = signWithPrivateKey(cfg.mchPrivateKeyPem, signStr);
  return { timeStamp, nonceStr, package: pkg, signType: 'RSA', paySign };
}

/** 主动查单：GET /v3/pay/transactions/out-trade-no/{out_trade_no} */
async function queryOrderByOutTradeNo(cfg, outTradeNo) {
  const urlPath = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${cfg.mchId}`;
  const res = await requestWechatPay('GET', urlPath, cfg, null);
  return res; // 含 trade_state / transaction_id / amount.total / __status
}

/**
 * 回调验签：平台证书 RSA-SHA256 校验 Wechatpay-Signature
 * 验签串 = timestamp\nnonce\nbody\n
 */
function verifyCallbackSignature(cfg, headers, rawBody) {
  const signature = headers['wechatpay-signature'];
  const timestamp = headers['wechatpay-timestamp'];
  const nonce = headers['wechatpay-nonce'];
  const serial = headers['wechatpay-serial'];
  if (!signature || !timestamp || !nonce) {
    return { ok: false, reason: 'MISSING_HEADER' };
  }
  // 时间窗校验：≤5 分钟（防重放）
  const tsSec = Number(timestamp);
  if (!Number.isFinite(tsSec) || Math.abs(Date.now() / 1000 - tsSec) > 300) {
    return { ok: false, reason: 'TIMESTAMP_WINDOW' };
  }
  try {
    const publicKey = crypto.createPublicKey(cfg.platformCertPem);
    const signStr = `${timestamp}\n${nonce}\n${rawBody}\n`;
    const valid = crypto
      .createVerify('RSA-SHA256')
      .update(signStr, 'utf8')
      .verify(publicKey, Buffer.from(signature, 'base64'));
    return { ok: valid, reason: valid ? 'OK' : 'SIGNATURE_MISMATCH', serial };
  } catch (e) {
    return { ok: false, reason: 'VERIFY_ERROR:' + e.message };
  }
}

/** 解密回调 resource（AES-256-GCM，tag 位于 ciphertext 尾部 16 字节） */
function decryptResource(apiV3Key, resource) {
  const { ciphertext, nonce, associated_data: aad } = resource || {};
  if (!ciphertext || !nonce || aad === undefined) {
    throw new Error('INVALID_RESOURCE');
  }
  const buf = Buffer.from(ciphertext, 'base64');
  if (buf.length < 16) throw new Error('CIPHERTEXT_TOO_SHORT');
  const tag = buf.slice(buf.length - 16);
  const data = buf.slice(0, buf.length - 16);
  const key = Buffer.from(apiV3Key, 'utf8'); // 要求 32 字节
  if (key.length !== 32) throw new Error('API_V3_KEY_LEN');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'utf8'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  let plain = decipher.update(data, null, 'utf8');
  plain += decipher.final('utf8');
  return JSON.parse(plain);
}

module.exports = {
  getPayConfig,
  createJsapiOrder,
  buildJsapiPayParams,
  queryOrderByOutTradeNo,
  verifyCallbackSignature,
  decryptResource
};

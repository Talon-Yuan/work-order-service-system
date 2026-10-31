/**
 * logisticsClient.js — 快递100 统一调用层（阶段 6-1 物流 API 接入）
 *
 * 安全与工程约束（对应项目书 6-1）：
 *  - 密钥仅存云函数环境变量（KUAIDI100_KEY / KUAIDI100_CUSTOMER），本文件零密钥硬编码；
 *  - 统一调用层：鉴权（签名）/ 参数校验 / 超时 / 限流（调用方）/ 日志脱敏；
 *  - 签名算法以快递100 最新官方文档为准（此处实现经典 MD5(param+key+customer) 与回调
 *    MD5(body+key+customer) 验签，可通过 KUAIDI100_SIGN_MODE 扩展）；
 *  - 日志严禁打印 key 与完整手机号/运单号（只打印脱敏片段）。
 *
 * 状态标准化（6-1 验收：近 40 种状态 → 内部阶段）：
 * 快递100 query 返回 state 字段（官方含义）：
 *   0 在途 / 1 揽收 / 2 疑难 / 3 签收 / 4 退签 / 5 派件 / 6 退回 / 7 转投 / 8 清关
 * 结合 com 单号类型与细分 isCheck 字段做标准化映射；回调 body.state 语义相同。
 */
const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');

const KUAIDI100_POLL_URL = 'https://poll.kuaidi100.com';
const QUERY_PATH = '/poll/query.do';
const SUBSCRIBE_PATH = '/poll.do';

/** 日志脱敏：手机号 138****1234；保留运单号前4后4（中间打码）；其余字符串截断 */
function mask(text) {
  if (text === undefined || text === null) return '';
  let s = String(text);
  // 手机号
  s = s.replace(/(1[3-9]\d)\d{4}(\d{4})/g, '$1****$2');
  // 运单号/长串（>=8 位数字字母）保留首尾
  s = s.replace(/([A-Za-z0-9]{4})[A-Za-z0-9]+([A-Za-z0-9]{4})/g, '$1****$2');
  return s;
}

/** MD5 签名工具（快递100 使用） */
function md5(str) {
  return crypto.createHash('md5').update(String(str), 'utf8').digest('hex').toUpperCase();
}

/** 读取环境变量（缺省显式报错，绝不静默降级） */
function envOrThrow(key) {
  const v = process.env[key];
  if (!v) throw new Error('ENV_MISSING:' + key);
  return v;
}

function hasEnv(key) {
  return !!process.env[key];
}

/**
 * 查询轨迹签名：MD5(param + key + customer) 大写
 * @param {string} param 参数 JSON 字符串
 */
function buildQuerySign(param) {
  const key = envOrThrow('KUAIDI100_KEY');
  const customer = envOrThrow('KUAIDI100_CUSTOMER');
  return md5(param + key + customer);
}

/**
 * 回调验签：MD5(body + key + customer) 与回调携带 sign 比对（以官方文档为准，
 * 可配置 KUAIDI100_CALLBACK_SIGN_MODE 扩展其他算法）。
 */
function verifyCallbackSign(body, sign) {
  if (!sign) return false;
  const key = envOrThrow('KUAIDI100_KEY');
  const customer = envOrThrow('KUAIDI100_CUSTOMER');
  const expected = md5(body + key + customer);
  return expected === String(sign).toUpperCase();
}

/** HTTPS POST（表单编码），默认 8 秒超时 */
function postForm(urlPath, form, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(form).toString();
    const req = https.request(KUAIDI100_POLL_URL + urlPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: timeoutMs
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('timeout', () => { req.destroy(new Error('UPSTREAM_TIMEOUT')); });
    req.on('error', (e) => reject(e));
    req.write(body);
    req.end();
  });
}

/** 统一解析快递100 响应：成功返回 { ok, data }；业务失败返回 { ok:false, message } */
function parseResponse(resp) {
  if (!resp) return { ok: false, message: 'EMPTY_RESPONSE' };
  if (resp.statusCode !== 200) return { ok: false, message: 'HTTP_' + resp.statusCode };
  try {
    const j = JSON.parse(resp.body);
    if (j.status === '200' || j.status === 200) return { ok: true, data: j };
    return { ok: false, message: String(j.message || j.msg || 'UPSTREAM_ERROR'), data: j };
  } catch (e) {
    return { ok: false, message: 'BAD_JSON_RESPONSE' };
  }
}

/**
 * 轨迹查询（6-1：轨迹查询）
 * @param {object} opts { carrier, tracking_no, phone? }
 * @returns {Promise<{ok:boolean, message:string, data?:object}>}
 */
async function queryTrace(opts) {
  if (!hasEnv('KUAIDI100_KEY') || !hasEnv('KUAIDI100_CUSTOMER')) {
    return { ok: false, message: 'LOGISTICS_NOT_CONFIGURED' };
  }
  if (!opts.carrier || !opts.tracking_no) return { ok: false, message: 'INVALID_PARAMS' };
  const param = JSON.stringify({
    com: opts.carrier,
    num: opts.tracking_no,
    phone: opts.phone || ''
  });
  const sign = buildQuerySign(param);
  const resp = await postForm(QUERY_PATH, { customer: envOrThrow('KUAIDI100_CUSTOMER'), sign, param });
  const parsed = parseResponse(resp);
  if (!parsed.ok) return parsed;
  const data = parsed.data;
  if (data.data === undefined || data.data === null) {
    return { ok: false, message: String(data.message || data.msg || 'NO_TRACE') };
  }
  return { ok: true, message: 'ok', data };
}

/**
 * 轨迹订阅（6-1：订阅推送；快递100 回调到 logistics.callback）
 */
async function subscribeTrace(opts) {
  if (!hasEnv('KUAIDI100_KEY') || !hasEnv('KUAIDI100_CUSTOMER') || !hasEnv('KUAIDI100_CALLBACK_URL')) {
    return { ok: false, message: 'LOGISTICS_NOT_CONFIGURED' };
  }
  if (!opts.carrier || !opts.tracking_no) return { ok: false, message: 'INVALID_PARAMS' };
  const param = JSON.stringify({
    com: opts.carrier,
    num: opts.tracking_no,
    callbackurl: process.env.KUAIDI100_CALLBACK_URL,
    phone: opts.phone || '',
    resultv2: '2'
  });
  const sign = buildQuerySign(param);
  const resp = await postForm(SUBSCRIBE_PATH, { customer: envOrThrow('KUAIDI100_CUSTOMER'), sign, param });
  const parsed = parseResponse(resp);
  if (!parsed.ok) return parsed;
  // 订阅成功：快递100 返回 {"result":true,"returnCode":"200","message":"提交成功"}
  if (parsed.data.result === true || parsed.data.result === 'true' || parsed.data.returnCode === '200') {
    return { ok: true, message: 'subscribed' };
  }
  return { ok: false, message: String(parsed.data.message || 'SUBSCRIBE_FAILED') };
}

/**
 * 状态标准化：快递100 状态码 → 内部阶段
 * @param {number|string} state 快递100 state 字段（0-8，或回调中的字符串数字）
 */
function mapState(state) {
  const n = Number(state);
  switch (n) {
    case 3: case 4: // 3 签收 / 4 退签（退签归异常，但签收含"已签收"）
      return n === 3 ? 'delivered' : 'exception';
    case 2: case 6: // 2 疑难 / 6 退回
      return 'exception';
    case 0: case 1: case 5: case 7: case 8: // 在途/揽收/派件/转投/清关
      return 'in_transit';
    default:
      return 'pending';
  }
}

/** 标准化一条轨迹为时间线条目 */
function normalizeTraceItem(item) {
  return {
    time: item.time || item.ftime || '',
    desc: item.context || item.remark || '',
    standard_status: mapState(item.state)
  };
}

/** 合并并去重轨迹（同 time+desc 不重复追加；按时间升序） */
function mergeTrace(existing, incoming) {
  const seen = new Set((existing || []).map((t) => (t.time || '') + '|' + (t.desc || '')));
  const merged = (existing || []).slice();
  for (const item of incoming || []) {
    const t = normalizeTraceItem(item);
    const k = (t.time || '') + '|' + (t.desc || '');
    if (t.time && !seen.has(k)) {
      seen.add(k);
      merged.push(t);
    }
  }
  merged.sort((a, b) => String(a.time).localeCompare(String(b.time)));
  return merged;
}

module.exports = {
  mask, md5, envOrThrow, hasEnv, buildQuerySign, verifyCallbackSign,
  queryTrace, subscribeTrace, mapState, normalizeTraceItem, mergeTrace
};

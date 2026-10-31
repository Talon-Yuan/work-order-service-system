/**
 * response.js — 统一响应格式
 * 所有云函数必须返回 { code, msg, data } 结构，前端 request.js 据此统一处理。
 */
function ok(data, msg) {
  return { code: 0, msg: msg || 'ok', data: data === undefined ? null : data };
}

function fail(code, msg, data) {
  return { code: code, msg: msg || 'error', data: data === undefined ? null : data };
}

module.exports = { ok, fail };

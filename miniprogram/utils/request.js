/**
 * utils/request.js — 云函数调用统一封装
 * 职责：
 *  1. 统一走 wx.cloud.callFunction（数据库零直连，服务端行级过滤）
 *  2. 统一注入来源端标记 _source: 'mini' | 'web'（仅用于日志/审计，不构成身份凭证）
 *  3. 统一错误码解析、超时处理、401 登录态过期跳转
 * 安全红线：
 *   - 前端永不直接调用 db.collection 读写业务数据（关键操作零直连）
 *   - 前端永不携带/存储密钥，OPENID 由服务端 cloud.getWXContext() 获取
 *   - 本文件不允许出现任何密钥字面量
 */
const { t } = require('./i18n');

const ERR_MSG = {
  400: 'badRequest',
  401: 'sessionExpired',
  403: 'permissionDenied',
  404: 'notFound',
  409: 'conflict',
  429: 'tooFrequent',
  500: 'serverError',
  503: 'serviceBusy'
};

/**
 * 调用云函数
 * @param {string} name 云函数名
 * @param {object} data 业务参数（不含 _source，自动注入）
 * @param {object} opts { source: 'mini'|'web', showLoading }
 * @returns {Promise<{code:number,msg:string,data:any}>} 统一响应结构
 */
function callFunction(name, data = {}, opts = {}) {
  const source = opts.source || 'mini';
  const showLoading = opts.showLoading !== false;

  if (showLoading) wx.showLoading({ title: t('loading'), mask: true });

  return wx.cloud.callFunction({
    name,
    data: Object.assign({}, data, { _source: source })
  }).then((res) => {
    if (showLoading) wx.hideLoading();
    const r = res.result || {};
    // 云函数统一响应结构：{ code, msg, data }
    if (r.code === 0) {
      return r;
    }
    // 401：会话过期 -> 引导重新登录
    if (r.code === 401) {
      wx.removeStorageSync('app_session');
      wx.reLaunch({ url: '/pages/login/login' });
    }
    const key = ERR_MSG[r.code] || 'serverError';
    wx.showToast({ title: t(key), icon: 'none' });
    return r;
  }).catch((err) => {
    if (showLoading) wx.hideLoading();
    console.error('[request] callFunction error:', err);
    wx.showToast({ title: t('networkError'), icon: 'none' });
    return { code: -1, msg: t('networkError'), data: null };
  });
}

module.exports = { callFunction };

/**
 * utils/i18n.js — 多语言框架（16 语言：zh-CN / zh-TW / en / ja-JP / ko-KR / fr / de / es / pt / ru / ar / hi / it / th / vi / id）
 * 提供：
 *   t(key, params)            取词，支持 {var} 占位符
 *   getLang() / setLang(lang) 语言读写，wx.setStorageSync 持久化
 *   apply(pageCtx, keys)      页面辅助：把词条映射到 this.data.i18n
 *   isRTL(lang)               RTL 方向标记（ar 为 RTL，页面根节点据此设置 direction）
 * 说明：微信开发者工具支持 require .json（编译期转为 JS 模块）。
 *       若构建器不支持，可将语言包复制为同名 .js（module.exports）并改此处 require。
 * 安全红线：语言包仅含 UI 文案，严禁写入任何密钥/凭据。
 */
const zh = require('./lang/zh-CN.json');
const zhTW = require('./lang/zh-TW.json');
const en = require('./lang/en.json');
const ja = require('./lang/ja-JP.json');
const ko = require('./lang/ko-KR.json');
const fr = require('./lang/fr.json');
const de = require('./lang/de.json');
const es = require('./lang/es.json');
const pt = require('./lang/pt.json');
const ru = require('./lang/ru.json');
const ar = require('./lang/ar.json');
const hi = require('./lang/hi.json');
const it = require('./lang/it.json');
const th = require('./lang/th.json');
const vi = require('./lang/vi.json');
const id = require('./lang/id.json');

const LANG_PACKS = {
  'zh-CN': zh,
  'zh-TW': zhTW,
  'en': en,
  'ja-JP': ja,
  'ko-KR': ko,
  'fr': fr,
  'de': de,
  'es': es,
  'pt': pt,
  'ru': ru,
  'ar': ar,
  'hi': hi,
  'it': it,
  'th': th,
  'vi': vi,
  'id': id
};
const DEFAULT_LANG = 'zh-CN';
const STORAGE_KEY = 'app_lang';

/** 读取当前语言（优先本地持久化） */
function getLang() {
  try {
    const v = wx.getStorageSync(STORAGE_KEY);
    if (v && LANG_PACKS[v]) return v;
  } catch (e) { /* ignore */ }
  return DEFAULT_LANG;
}

/** 设置语言并持久化 */
function setLang(lang) {
  if (!LANG_PACKS[lang]) return false;
  try {
    wx.setStorageSync(STORAGE_KEY, lang);
    return true;
  } catch (e) {
    return false;
  }
}

/** 取词：t('loginBtn') -> '微信一键登录'；支持 t('orderNo', { no: 'SO2026...' }) */
function t(key, params) {
  const pack = LANG_PACKS[getLang()] || zh;
  let s = pack[key] || zh[key];
  if (s === undefined || s === null) {
    s = key; // 缺失词条回退为 key，便于开发期发现
  }
  if (params) {
    for (const k in params) {
      s = String(s).replace(new RegExp('\\{' + k + '\\}', 'g'), String(params[k]));
    }
  }
  return s;
}

/** 页面辅助：apply(this, ['loginBtn','slogan']) -> this.data.i18n.loginBtn = 词条 */
function apply(pageCtx, keys) {
  const map = {};
  (keys || []).forEach((k) => { map[k] = t(k); });
  pageCtx.setData({ i18n: map });
}

/** RTL 方向标记：ar 返回 true，其余 false（页面根节点 direction 依据） */
function isRTL(lang) {
  return /^ar(-|$)/.test(lang || getLang());
}

/** 初始化（App.onLaunch 调用） */
function initI18n() {
  getLang();
}

module.exports = { t, getLang, setLang, apply, initI18n, isRTL, LANG_PACKS, STORAGE_KEY };

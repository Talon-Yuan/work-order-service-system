/**
 * app.js — 小程序入口
 * 安全红线（见 docs/security-checklist.md）：
 *   前端零密钥 / 数据库零全开 / 身份零信任 / 关键操作零直连 / 明文密码零存储
 * 本文件不包含任何密钥、AppSecret、商户号、Token 字面量。
 */
const { initI18n, getLang, setLang, t } = require('./utils/i18n');

App({
  globalData: {
    lang: 'zh-CN',
    session: null,           // 由 login 云函数返回的会话标识（仅用于 UI 状态）
    envId: '',               // 云开发环境 ID：部署时在 project.config.json / env 中注入，不入库明文
    openid: null,            // 由云函数服务端获取后回填，前端不自行断言
    userInfo: null
  },

  onLaunch() {
    // 初始化多语言：读取本地持久化语言，默认 zh-CN
    this.globalData.lang = getLang();
    initI18n();

    if (!wx.cloud) {
      console.error('当前基础库版本过低，无法使用云能力');
      return;
    }
    // 云开发初始化：环境 ID 从构建配置注入（project.config.json 或 CI 环境变量），
    // 严禁硬编码到源码；此处留空将由部署脚本写入 envList。
    wx.cloud.init({ env: this.globalData.envId || undefined, traceUser: true });
  },

  onShow() {
    // 语言变更后回到前台，刷新全局语言
    this.globalData.lang = getLang();
  },

  /** 切换语言并持久化（zh-CN / en / ja-JP / ko-KR） */
  switchLang(lang) {
    setLang(lang);
    this.globalData.lang = lang;
  },

  t(key, params) {
    return t(key, params);
  }
});

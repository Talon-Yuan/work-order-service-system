// pages/login/login.js
const { t, apply } = require('../../utils/i18n');
const { callFunction } = require('../../utils/request');
Page({
  data: { i18n: {}, submitting: false },
  onLoad() { apply(this, ['loginWechat','slogan','loginBtn']); },
  onShow() { apply(this, ['loginWechat','slogan','loginBtn']); },
  async onLogin() {
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    try {
      const res = await callFunction('login', { _source: 'mini', scene: 'wechat' });
      if (res.code === 0) {
        getApp().globalData.session = res.data.session;
        wx.reLaunch({ url: '/pages/index/index' });
      } else {
        wx.showToast({ title: res.msg || t('loginFailed'), icon: 'none' });
      }
    } catch (e) {
      wx.showToast({ title: t('networkError'), icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },
});

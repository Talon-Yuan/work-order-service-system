// pages/subscribe/subscribe.js — 订阅管理（阶段6：任务 6-3）
// templates：列出 6 类模板（template_id 由云函数从环境变量下发，前端零密钥）；
// allow：用户点击模板 → wx.requestSubscribeMessage 授权 → subscribe.allow 登记；
// list：展示本人各模板授权状态。
const { t, apply } = require('../../utils/i18n');
const { callFunction } = require('../../utils/request');

Page({
  data: { i18n: {}, items: [], loading: true },

  onLoad() { apply(this, ['subscribeTitle', 'subscribeManage', 'subscribeGuide']); },
  onShow() {
    apply(this, ['subscribeTitle', 'subscribeManage', 'subscribeGuide']);
    this.load();
  },

  load() {
    this.setData({ loading: true });
    callFunction('subscribe', { action: 'subscribe.list' }).then((r) => {
      this.setData({ loading: false });
      if (r && r.code === 0) this.setData({ items: (r.data.items || []) });
    });
  },

  onGrant(e) {
    const idx = e.currentTarget.dataset.idx;
    const item = this.data.items[idx];
    if (!item || item.granted || !item.configured) return;
    wx.requestSubscribeMessage({
      tmplIds: [item.template_id],
      success: (res) => {
        if (res[item.template_id] === 'accept') {
          callFunction('subscribe', { action: 'subscribe.allow', template_types: [item.template_type] }).then((r) => {
            if (r && r.code === 0) {
              wx.showToast({ title: t('subscribeGrantSuccess'), icon: 'success' });
              this.load();
            } else {
              wx.showToast({ title: t('subscribeGrantFail'), icon: 'none' });
            }
          });
        } else {
          wx.showToast({ title: t('subscribeGrantFail'), icon: 'none' });
        }
      },
      fail: () => wx.showToast({ title: t('subscribeGrantFail'), icon: 'none' })
    });
  }
});

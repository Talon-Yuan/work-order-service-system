// pages/checkout/checkout.js — 确认订单（阶段 4：任务 4-3）
// 读取小程序本地购物车，提交 order.create 云函数（事务防超卖）。
const { t, apply } = require('../../utils/i18n');
const { callFunction } = require('../../utils/request');

const CART_KEY = 'app_cart';

Page({
  data: { i18n: {}, items: [], total_yuan: '0.00', submitting: false },

  onLoad() { apply(this, ['checkout']); },
  onShow() {
    apply(this, ['checkout']);
    this.loadCart();
  },

  loadCart() {
    const cart = wx.getStorageSync(CART_KEY) || [];
    const items = cart.map((it) => ({
      ...it,
      subtotal_yuan: (((it.price_fen || 0) * it.quantity) / 100).toFixed(2)
    }));
    const totalFen = cart.reduce((s, it) => s + (it.price_fen || 0) * it.quantity, 0);
    this.setData({ items, total_yuan: (totalFen / 100).toFixed(2) });
  },

  onSubmit() {
    if (this.data.submitting) return;
    const cart = wx.getStorageSync(CART_KEY) || [];
    if (!cart.length) {
      wx.showToast({ title: t('cartEmpty'), icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    callFunction('order', {
      action: 'order.create',
      items: cart.map((it) => ({ part_id: it.part_id, quantity: it.quantity })),
      remark: '',
      address: ''
    }).then((r) => {
      this.setData({ submitting: false });
      if (r && r.code === 0) {
        wx.removeStorageSync(CART_KEY);
        wx.showToast({ title: t('orderCreated'), icon: 'success' });
        wx.redirectTo({ url: '/pages/orders/orders' });
      }
    });
  }
});

// pages/store/store.js — 备件商城（阶段 4：任务 4-3）
// 商城列表走 spare-parts.store.list（公开只读）；加入购物车走小程序本地 storage；
// 下单走 order.create 云函数（事务防超卖）。
const { t, apply } = require('../../utils/i18n');
const { callFunction } = require('../../utils/request');

const CART_KEY = 'app_cart';

Page({
  data: { i18n: {}, parts: [], loading: true, cartCount: 0 },

  onLoad() { apply(this, ['store']); },
  onShow() {
    apply(this, ['store']);
    this.loadParts();
    this.refreshCartCount();
  },

  loadParts() {
    this.setData({ loading: true });
    callFunction('spare-parts', { action: 'store.list', page: 1, page_size: 20 }).then((r) => {
      this.setData({ loading: false });
      if (r && r.code === 0) {
        const parts = (r.data.list || []).map((p) => ({
          ...p,
          price_yuan: ((p.price_fen || 0) / 100).toFixed(2)
        }));
        this.setData({ parts });
      }
    });
  },

  refreshCartCount() {
    const cart = wx.getStorageSync(CART_KEY) || [];
    const count = cart.reduce((s, it) => s + (it.quantity || 0), 0);
    this.setData({ cartCount: count });
  },

  onAddCart(e) {
    const id = e.currentTarget.dataset.id;
    const part = this.data.parts.find((p) => p._id === id);
    if (!part) return;
    const cart = wx.getStorageSync(CART_KEY) || [];
    const hit = cart.find((it) => it.part_id === id);
    if (hit) hit.quantity = Math.min(99, hit.quantity + 1);
    else cart.push({
      part_id: id,
      part_name: part.part_name,
      part_no: part.part_no,
      price_fen: part.price_fen || 0,
      quantity: 1
    });
    wx.setStorageSync(CART_KEY, cart);
    this.refreshCartCount();
    wx.showToast({ title: t('addedToCart'), icon: 'success' });
  },

  onGoCheckout() {
    const cart = wx.getStorageSync(CART_KEY) || [];
    if (!cart.length) {
      wx.showToast({ title: t('cartEmpty'), icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/checkout/checkout' });
  }
});

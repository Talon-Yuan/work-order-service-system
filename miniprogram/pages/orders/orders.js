// pages/orders/orders.js — 我的订单与状态流转（阶段 4：任务 4-5）
// 订单列表走 order.list；支付走 pay.create + wx.requestPayment；
// 确认收货走 order.complete；申请开票走 invoice.request。
const { t, apply } = require('../../utils/i18n');
const { callFunction } = require('../../utils/request');

const STATUS_KEY = {
  pending: 'orderPending',
  paid: 'orderPaid',
  shipped: 'orderShipped',
  completed: 'orderDone',
  cancelled: 'orderCanceled',
  refunded: 'orderRefunded'
};

const INVOICE_KEY = {
  not_invoiced: 'notInvoiced',
  invoice_requested: 'invoiceRequested',
  invoiced: 'invoiced'
};

Page({
  data: { i18n: {}, orders: [], loading: true },

  onLoad() { apply(this, ['myOrders']); },
  onShow() {
    apply(this, ['myOrders']);
    this.loadOrders();
  },

  loadOrders() {
    this.setData({ loading: true });
    callFunction('order', { action: 'order.list', page: 1, page_size: 20 }).then((r) => {
      this.setData({ loading: false });
      if (r && r.code === 0) {
        const orders = (r.data.list || []).map((o) => ({
          ...o,
          total_yuan: ((o.total_fen || 0) / 100).toFixed(2),
          status_label: t(STATUS_KEY[o.status] || 'orderPending'),
          invoice_label: t(INVOICE_KEY[o.invoice_status] || 'notInvoiced')
        }));
        this.setData({ orders });
      }
    });
  },

  onPay(e) {
    const id = e.currentTarget.dataset.id;
    callFunction('pay', { action: 'pay.create', order_id: id }).then((r) => {
      if (!r || r.code !== 0) return;
      const p = r.data;
      wx.requestPayment({
        timeStamp: p.timeStamp,
        nonceStr: p.nonceStr,
        package: p.package,
        signType: p.signType,
        paySign: p.paySign,
        success: () => {
          wx.showToast({ title: t('paySuccess'), icon: 'success' });
          this.loadOrders();
        },
        fail: () => {
          wx.showToast({ title: t('payFailed'), icon: 'none' });
          this.loadOrders();
        }
      });
    });
  },

  onComplete(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: t('confirmReceive'),
      content: t('confirmReceiveHint'),
      success: (res) => {
        if (!res.confirm) return;
        callFunction('order', { action: 'order.complete', order_id: id }).then((r) => {
          if (r && r.code === 0) this.loadOrders();
        });
      }
    });
  },

  onInvoice(e) {
    const id = e.currentTarget.dataset.id;
    callFunction('invoice', { action: 'invoice.request', order_id: id }).then((r) => {
      if (r && r.code === 0) {
        wx.showToast({ title: t('invoiceRequested'), icon: 'success' });
      }
      this.loadOrders();
    });
  },

  onLogistics(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/logistics/logistics?order_id=' + id });
  }
});

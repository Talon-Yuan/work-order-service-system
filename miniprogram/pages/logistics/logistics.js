// pages/logistics/logistics.js — 物流追踪（阶段6：任务 6-1/6-2）
// 列表：logistics.list；轨迹：logistics.trace（含签收联动）；
// 订阅：wx.requestSubscribeMessage 授权后 subscribe.allow 登记（前端零密钥，模板ID来自模板列表）。
const { t, apply } = require('../../utils/i18n');
const { callFunction } = require('../../utils/request');

const STATUS_KEY = {
  pending: 'logisticsStatusPending',
  in_transit: 'logisticsStatusInTransit',
  delivered: 'logisticsStatusDelivered',
  exception: 'logisticsStatusException'
};

Page({
  data: { i18n: {}, list: [], detail: null, traces: [], loading: true, detailLoading: false, active: null },

  onLoad(opts) {
    apply(this, ['logisticsTitle', 'logisticsDynamic', 'logisticsSubscribe']);
    if (opts && opts.order_id) this.order_id = opts.order_id;
  },
  onShow() {
    apply(this, ['logisticsTitle', 'logisticsDynamic', 'logisticsSubscribe']);
    this.loadList();
  },

  loadList() {
    this.setData({ loading: true });
    callFunction('logistics', { action: 'logistics.list' }).then((r) => {
      this.setData({ loading: false });
      if (r && r.code === 0) {
        const list = (r.data.list || []).map((w) => ({
          ...w, status_label: t(STATUS_KEY[w.status] || 'logisticsStatusPending')
        }));
        this.setData({ list });
        if (this.order_id) {
          const hit = list.find((w) => w.order_id === this.order_id);
          if (hit) this.onSelect({ currentTarget: { dataset: { id: hit._id } } });
        }
      }
    });
  },

  onSelect(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ detailLoading: true, active: id });
    callFunction('logistics', { action: 'logistics.trace', waybill_id: id }).then((r) => {
      this.setData({ detailLoading: false });
      if (r && r.code === 0) {
        const d = r.data.waybill || {};
        const traces = (r.data.trace || []).map((x) => ({ ...x }));
        this.setData({
          detail: {
            ...d,
            order_no: d.order_no || '',
            carrier: d.carrier || '',
            tracking_no: d.tracking_no || '',
            status_label: t(STATUS_KEY[d.status] || 'logisticsStatusPending'),
            subscribed: !!d.subscribed
          },
          traces
        });
      }
    });
  },

  onBack() { this.setData({ detail: null, traces: [], active: null }); },

  // 订阅物流动态：先取模板ID → wx.requestSubscribeMessage → subscribe.allow 登记
  onSubscribe() {
    const d = this.data.detail;
    if (!d) return;
    callFunction('subscribe', { action: 'subscribe.templates' }).then((r) => {
      if (!r || r.code !== 0) return;
      const tmpl = (r.data.items || []).find((x) => x.template_type === 'logistics_dynamic');
      if (!tmpl || !tmpl.template_id || !tmpl.configured) {
        wx.showToast({ title: t('subscribeGrantFail'), icon: 'none' });
        return;
      }
      wx.requestSubscribeMessage({
        tmplIds: [tmpl.template_id],
        success: (res) => {
          if (res[tmpl.template_id] === 'accept') {
            callFunction('subscribe', { action: 'subscribe.allow', template_types: ['logistics_dynamic'] }).then((r2) => {
              if (r2 && r2.code === 0) {
                wx.showToast({ title: t('subscribeGrantSuccess'), icon: 'success' });
                this.setData({ 'detail.subscribed': true });
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
    });
  }
});

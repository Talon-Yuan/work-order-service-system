// pages/dashboard/dashboard.js — 数据看板（阶段7-1：任务 7-1/7-4）
// 看板聚合全部在云函数 dashboard 内完成；客户视角不返回成本/库存等内部指标（最小返回）。
const { t, apply } = require('../../utils/i18n');
const { callFunction } = require('../../utils/request');

const STATUS_KEY = {
  pending: 'dashboardStatusPending',
  processing: 'dashboardStatusProcessing',
  pending_acceptance: 'dashboardStatusPendingAcceptance',
  accepted: 'dashboardStatusAccepted',
  rejected: 'dashboardStatusRejected',
  closed: 'dashboardStatusClosed'
};
const DASH_KEYS = [
  'dashboardTitle', 'dashboardDynamic', 'dashboardWorkOrders', 'dashboardAppointments',
  'dashboardLowStock', 'dashboardCost', 'dashboardTrend', 'dashboardTotal', 'dashboardPending',
  'dashboardByStatus', 'dashboardAvg', 'dashboardOpenCost', 'dashboardOpenExport',
  'dashboardStatusPending', 'dashboardStatusProcessing', 'dashboardStatusPendingAcceptance',
  'dashboardStatusAccepted', 'dashboardStatusRejected', 'dashboardStatusClosed', 'empty'
];

Page({
  data: { i18n: {}, loading: true, kpi: null, statusList: [], trend: [], role: '', internal: false },

  onLoad() { apply(this, DASH_KEYS); },
  onShow() { apply(this, DASH_KEYS); this.load(); },

  load() {
    this.setData({ loading: true });
    callFunction('dashboard', { action: 'dashboard.overview', days: 30 }).then((r) => {
      this.setData({ loading: false });
      if (r && r.code === 0) {
        const d = r.data;
        const internal = d.role !== 'customer';
        const byStatus = (d.kpi.work_orders.by_status) || {};
        const statusList = Object.keys(byStatus).map((k) => ({
          key: k, label: t(STATUS_KEY[k] || k), count: byStatus[k] || 0
        }));
        const trendAll = d.trend || [];
        const trend = trendAll.slice(-14).map((x) => ({
          date: x.date.slice(5), work_orders: x.work_orders,
          appointments: x.appointments, cost_fen: x.cost_fen
        }));
        this.setData({ kpi: d.kpi, statusList, trend, role: d.role, internal });
      }
    });
  },

  onGoCost() { wx.navigateTo({ url: '/pages/cost/cost' }); },
  onGoExport() { wx.navigateTo({ url: '/pages/export/export' }); }
});

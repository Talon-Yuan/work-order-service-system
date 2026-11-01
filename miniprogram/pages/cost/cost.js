// pages/cost/cost.js — 成本统计（阶段7-2：任务 7-2/7-4）
// 成本口径服务端计算（cost-stats）；成本参数写仅 admin（ROLE_CAPS 已控制，前端只读展示/表单提交）。
const { t, apply } = require('../../utils/i18n');
const { callFunction } = require('../../utils/request');

const COST_KEYS = [
  'costTitle', 'costDynamic', 'costTotal', 'costParts', 'costLabor', 'costTransport',
  'costAvg', 'costCount', 'costTrend', 'costComposition', 'costTop10', 'costConfig',
  'costLaborRate', 'costTransportBase', 'costTransportPerKm', 'costSave', 'costEditing',
  'costNoData', 'costUpdatedAt', 'empty', 'loading'
];

Page({
  data: {
    i18n: {}, loading: true, summary: null, trend: [], composition: [], top: [],
    config: null, role: '', canWrite: false, editing: false,
    form: { labor_hour_rate_fen: '', transport_base_fen: '', transport_per_km_fen: '' }
  },

  onLoad() { apply(this, COST_KEYS); },
  onShow() { apply(this, COST_KEYS); this.load(); },

  load() {
    this.setData({ loading: true });
    Promise.all([
      callFunction('cost-stats', { action: 'cost.stats.read', months: 6 }),
      callFunction('cost-stats', { action: 'cost.config.read' })
    ]).then(([stats, cfg]) => {
      this.setData({ loading: false });
      if (stats && stats.code === 0) {
        const s = stats.data;
        const sum = s.summary || {};
        this.setData({
          summary: {
            total_cost_yuan: ((sum.total_cost_fen || 0) / 100).toFixed(2),
            avg_cost_yuan: ((sum.avg_cost_fen || 0) / 100).toFixed(2),
            parts_cost_yuan: ((sum.parts_cost_fen || 0) / 100).toFixed(2),
            labor_fee_yuan: ((sum.labor_fee_fen || 0) / 100).toFixed(2),
            transport_fee_yuan: ((sum.transport_fee_fen || 0) / 100).toFixed(2),
            work_order_count: sum.work_order_count
          },
          trend: (s.trend || []).map((x) => ({ ...x, total_yuan: (x.total_cost_fen / 100).toFixed(2) })),
          composition: (s.composition || []).map((c) => ({ ...c, yuan: (c.fen / 100).toFixed(2) })),
          top: (s.top || []).map((x) => ({ ...x, cost_yuan: (x.total_cost_fen / 100).toFixed(2) })),
          role: s.role,
          canWrite: s.role === 'admin'
        });
      }
      if (cfg && cfg.code === 0) {
        this.setData({ config: cfg.data });
      }
    });
  },

  onEditConfig() {
    const c = this.data.config || {};
    this.setData({
      editing: true,
      form: {
        labor_hour_rate_fen: c.labor_rate && c.labor_rate.per_hour_fen != null ? String(c.labor_rate.per_hour_fen / 100) : '',
        transport_base_fen: c.transport && c.transport.base_fen != null ? String(c.transport.base_fen / 100) : '',
        transport_per_km_fen: c.transport && c.transport.per_km_fen != null ? String(c.transport.per_km_fen / 100) : ''
      }
    });
  },
  onCancelEdit() { this.setData({ editing: false }); },
  onInput(e) {
    this.setData({ ['form.' + e.currentTarget.dataset.key]: e.detail.value });
  },
  onSaveConfig() {
    const f = this.data.form;
    const yuan = (v) => (parseFloat(v) || 0);
    callFunction('cost-stats', {
      action: 'cost.config.write',
      labor_hour_rate_fen: Math.round(yuan(f.labor_hour_rate_fen) * 100),
      transport_base_fen: Math.round(yuan(f.transport_base_fen) * 100),
      transport_per_km_fen: Math.round(yuan(f.transport_per_km_fen) * 100)
    }).then((r) => {
      if (r && r.code === 0) {
        this.setData({ editing: false });
        this.load();
      }
    });
  }
});

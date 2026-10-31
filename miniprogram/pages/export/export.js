// pages/export/export.js — 报表导出 Excel（阶段7-3：任务 7-3/7-4）
// 前端零密钥：导出由云函数生成 Excel 并写入私有读存储，仅返回临时链接；
// 前端 wx.downloadFile + wx.openDocument 预览/分享；导出记录归属校验在服务端。
const { t, apply } = require('../../utils/i18n');
const { callFunction } = require('../../utils/request');

const TYPE_KEY = {
  workorders: 'exportTypeWorkorders',
  maintenance_report: 'exportTypeMaintenance',
  inventory_flows: 'exportTypeInventory',
  evaluations: 'exportTypeEvaluations'
};
const EXPORT_KEYS = [
  'exportTitle', 'exportDynamic', 'exportType', 'exportTypeWorkorders', 'exportTypeMaintenance',
  'exportTypeInventory', 'exportTypeEvaluations', 'exportStart', 'exportEnd', 'exportStatusFilter',
  'exportCreate', 'exportCreating', 'exportHistory', 'exportRows', 'exportExpireAt',
  'exportGetLink', 'exportExpired', 'exportNoData', 'exportFileReady', 'exportDatePlaceholder',
  'empty', 'loading', 'cancel'
];

Page({
  data: {
    i18n: {}, types: [], currentType: 'workorders', start: '', end: '', status: '',
    creating: false, list: [], loading: true, page: 1, total: 0
  },

  onLoad() {
    apply(this, EXPORT_KEYS);
    this.setData({ types: Object.keys(TYPE_KEY).map((k) => ({ key: k, label: t(TYPE_KEY[k]) })) });
  },
  onShow() { apply(this, EXPORT_KEYS); this.loadList(); },

  loadList() {
    this.setData({ loading: true });
    callFunction('export', { action: 'export.list', page: 1, page_size: 20 }).then((r) => {
      this.setData({ loading: false });
      if (r && r.code === 0) {
        const list = (r.data.list || []).map((x) => ({
          ...x,
          type_label: t(TYPE_KEY[x.export_type] || x.export_type),
          created_text: fmt(x.created_at),
          expire_text: fmt(x.expire_at)
        }));
        this.setData({ list, total: r.data.total || 0 });
      }
    });
  },

  onPickType(e) { this.setData({ currentType: e.currentTarget.dataset.type }); },
  onStart(e) { this.setData({ start: e.detail.value }); },
  onEnd(e) { this.setData({ end: e.detail.value }); },
  onStatus(e) { this.setData({ status: e.detail.value }); },

  onCreate() {
    if (this.data.creating) return;
    this.setData({ creating: true });
    callFunction('export', {
      action: 'export.create',
      export_type: this.data.currentType,
      start: this.data.start,
      end: this.data.end,
      status: this.data.status,
      max_age: 1800
    }).then((r) => {
      this.setData({ creating: false });
      if (r && r.code === 0) {
        wx.showToast({ title: t('exportFileReady'), icon: 'success' });
        this.downloadAndOpen(r.data.temp_file_url, r.data.file_name);
        this.loadList();
      }
    });
  },

  onGetLink(e) {
    const id = e.currentTarget.dataset.id;
    callFunction('export', { action: 'export.get', export_id: id, max_age: 1800 }).then((r) => {
      if (r && r.code === 0) this.downloadAndOpen(r.data.temp_file_url, r.data.file_name);
    });
  },

  downloadAndOpen(url, fileName) {
    wx.showLoading({ title: t('exportCreating'), mask: true });
    wx.downloadFile({
      url,
      success: (res) => {
        wx.hideLoading();
        if (res.statusCode === 200) {
          wx.openDocument({
            filePath: res.tempFilePath,
            fileType: 'xlsx',
            showMenu: true,
            fail: () => wx.showToast({ title: t('networkError'), icon: 'none' })
          });
        } else {
          wx.showToast({ title: t('networkError'), icon: 'none' });
        }
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: t('networkError'), icon: 'none' });
      }
    });
  }
});

function fmt(d) {
  if (!d) return '';
  const dt = new Date(d);
  const pad = (n) => String(n).padStart(2, '0');
  return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate()) + ' ' + pad(dt.getHours()) + ':' + pad(dt.getMinutes());
}

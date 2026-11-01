// pages/review/review.js — 服务评价（阶段8-2：任务 8-2）
// 功能：评价提交（工单号+星级+标签+文字）、评价列表、满意度统计（内部角色）
// 安全：评价提交经云函数服务端校验工单归属与唯一性；统计接口客户无权限时自动隐藏。
const { t, apply } = require('../../utils/i18n');
const { callFunction } = require('../../utils/request');

const REVIEW_KEYS = [
  'reviewTitle', 'reviewDynamic', 'reviewSubmit', 'reviewWoId', 'reviewWoIdPlaceholder',
  'reviewRating', 'reviewTags', 'reviewContent', 'reviewContentPlaceholder', 'reviewSubmitSuccess',
  'reviewList', 'reviewEmpty', 'reviewStats', 'reviewAvg', 'reviewTotal', 'reviewDist',
  'reviewEvalOnce', 'reviewNoEvalYet', 'reviewTagProfessional', 'reviewTagPunctual',
  'reviewTagPolite', 'reviewTagPrice', 'empty', 'loading'
];
const TAG_KEYS = [
  { key: 'professional', label: 'reviewTagProfessional' },
  { key: 'punctual', label: 'reviewTagPunctual' },
  { key: 'polite', label: 'reviewTagPolite' },
  { key: 'price', label: 'reviewTagPrice' }
];

Page({
  data: {
    i18n: {}, woId: '', rating: 5, tags: [], content: '', submitting: false,
    list: [], total: 0, loading: true, stats: null, showStats: false, page: 1
  },

  onLoad() {
    apply(this, REVIEW_KEYS);
    this.setData({ tagOptions: TAG_KEYS.map((x) => ({ key: x.key, label: t(x.label), on: false })) });
  },
  onShow() {
    apply(this, REVIEW_KEYS);
    this.loadList();
    this.loadStats();
  },

  loadStats() {
    callFunction('evaluation', { action: 'eval.stats' }).then((r) => {
      if (r && r.code === 0) {
        this.setData({ stats: r.data, showStats: true });
      } else {
        this.setData({ stats: null, showStats: false }); // 客户无 EVAL_STATS 权限，隐藏统计区
      }
    });
  },

  loadList() {
    this.setData({ loading: true });
    callFunction('evaluation', { action: 'eval.list', page: 1, page_size: 20 }).then((r) => {
      this.setData({ loading: false });
      if (r && r.code === 0) {
        const list = (r.data.list || []).map((it) => Object.assign({}, it, {
          tags_text: (it.tags || []).join('、')
        }));
        this.setData({ list, total: r.data.total || 0 });
      }
    });
  },

  onWoId(e) { this.setData({ woId: e.detail.value }); },
  onRating(e) { this.setData({ rating: Number(e.currentTarget.dataset.value) }); },
  onTag(e) {
    const key = e.currentTarget.dataset.key;
    const tags = this.data.tags.slice();
    const i = tags.indexOf(key);
    if (i >= 0) tags.splice(i, 1); else tags.push(key);
    const tagOptions = this.data.tagOptions.map((x) => Object.assign({}, x, { on: tags.indexOf(x.key) >= 0 }));
    this.setData({ tags, tagOptions });
  },
  onContent(e) { this.setData({ content: e.detail.value }); },

  onSubmit() {
    if (this.data.submitting) return;
    const woId = (this.data.woId || '').trim();
    if (!woId) {
      wx.showToast({ title: t('reviewWoIdPlaceholder'), icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    callFunction('evaluation', {
      action: 'eval.create',
      work_order_id: woId,
      rating: this.data.rating,
      tags: this.data.tags,
      content: this.data.content
    }).then((r) => {
      this.setData({ submitting: false });
      if (r && r.code === 0) {
        wx.showToast({ title: t('reviewSubmitSuccess'), icon: 'success' });
        this.setData({ woId: '', rating: 5, tags: [], content: '', tagOptions: this.data.tagOptions.map((x) => Object.assign({}, x, { on: false })) });
        this.loadList();
        this.loadStats();
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
module.exports = undefined;

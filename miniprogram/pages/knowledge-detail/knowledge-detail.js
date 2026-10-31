// pages/knowledge-detail/knowledge-detail.js — 知识库详情（阶段8-3）
// 功能：文章详情展示、浏览量、内部角色编辑/删除入口
// 安全：详情经云函数 canSee 二次校验（客户访问 internal/未发布文章返回 403）
const { t, apply } = require('../../utils/i18n');
const { callFunction } = require('../../utils/request');

const KEYS = [
  'kbDetailTitle', 'kbBack', 'kbCategory', 'kbPublishedAt', 'kbViewCount', 'kbAuthor',
  'kbVisibilityPublic', 'kbVisibilityInternal', 'kbInternalOnly', 'kbEdit', 'kbDelete',
  'kbDeleteConfirm', 'kbUpdated', 'kbDeleted', 'confirm', 'cancel', 'edit', 'delete'
];
const CAT_KEYS = { guide: 'kbGuide', faq: 'kbFaq', tutorial: 'kbTutorial', policy: 'kbPolicy' };
const STATUS_KEYS = { draft: 'kbStatusDraft', published: 'kbStatusPublished', archived: 'kbStatusArchived' };
const VIS_KEYS = { public: 'kbVisibilityPublic', internal: 'kbVisibilityInternal' };

Page({
  data: {
    i18n: {}, id: '', article: null, loading: true, editing: false,
    form: { title: '', category: 'guide', visibility: 'public', status: 'draft', content: '' },
    visOptions: [], statusOptions: [], catOptions: []
  },

  onLoad(options) {
    apply(this, KEYS);
    this.setData({
      id: options.id || '',
      catOptions: ['guide', 'faq', 'tutorial', 'policy'].map((c) => ({ key: c, label: t(CAT_KEYS[c]) })),
      visOptions: [
        { key: 'public', label: t('kbVisibilityPublic') },
        { key: 'internal', label: t('kbVisibilityInternal') }
      ],
      statusOptions: ['draft', 'published', 'archived'].map((s) => ({ key: s, label: t(STATUS_KEYS[s]) }))
    });
    this.loadDetail();
  },
  onShow() { apply(this, KEYS); },

  loadDetail() {
    this.setData({ loading: true });
    callFunction('knowledge', { action: 'knowledge.detail', article_id: this.data.id }).then((r) => {
      this.setData({ loading: false });
      if (r && r.code === 0) {
        const a = r.data;
        this.setData({
          article: {
            ...a,
            cat_label: t(CAT_KEYS[a.category] || a.category),
            status_label: t(STATUS_KEYS[a.status] || a.status),
            vis_label: t(VIS_KEYS[a.visibility] || a.visibility),
            published_text: fmt(a.published_at),
            updated_text: fmt(a.updated_at)
          }
        });
      }
    });
  },

  onBack() { wx.navigateBack({ delta: 1 }); },

  onEdit() {
    const a = this.data.article;
    this.setData({ editing: true,
      form: { title: a.title, category: a.category, visibility: a.visibility, status: a.status, content: a.content } });
  },
  onCancelEdit() { this.setData({ editing: false }); },
  onFTitle(e) { this.setData({ 'form.title': e.detail.value }); },
  onFContent(e) { this.setData({ 'form.content': e.detail.value }); },
  onFCategory(e) { this.setData({ 'form.category': e.currentTarget.dataset.key }); },
  onFVisibility(e) { this.setData({ 'form.visibility': e.currentTarget.dataset.key }); },
  onFStatus(e) { this.setData({ 'form.status': e.currentTarget.dataset.key }); },

  onSave() {
    const f = this.data.form;
    if (!(f.title || '').trim() || !(f.content || '').trim()) {
      wx.showToast({ title: t('badRequest'), icon: 'none' }); return;
    }
    callFunction('knowledge', {
      action: 'knowledge.update', article_id: this.data.id,
      title: f.title, category: f.category, visibility: f.visibility, status: f.status, content: f.content, tags: []
    }).then((r) => {
      if (r && r.code === 0) {
        wx.showToast({ title: t('kbUpdated'), icon: 'success' });
        this.setData({ editing: false });
        this.loadDetail();
      }
    });
  },

  onDelete() {
    wx.showModal({
      title: t('confirm'), content: t('kbDeleteConfirm'), confirmColor: '#E5484D',
      success: (res) => {
        if (!res.confirm) return;
        callFunction('knowledge', { action: 'knowledge.delete', article_id: this.data.id }).then((r) => {
          if (r && r.code === 0) {
            wx.showToast({ title: t('kbDeleted'), icon: 'success' });
            setTimeout(() => wx.navigateBack({ delta: 1 }), 600);
          }
        });
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

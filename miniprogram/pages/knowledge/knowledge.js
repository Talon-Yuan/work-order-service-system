// pages/knowledge/knowledge.js — 知识库（阶段8-3：任务 8-3）
// 功能：文章列表（分类筛选+关键词搜索）、两级可见标签、内部角色新建/编辑/删除/从工单沉淀
// 安全：客户视角由云函数服务端过滤（仅 public+published），前端不直连数据库。
const { t, apply } = require('../../utils/i18n');
const { callFunction } = require('../../utils/request');

const KNOWLEDGE_KEYS = [
  'knowledgeTitle', 'knowledgeDynamic', 'kbSearchPlaceholder', 'kbAll', 'kbGuide', 'kbFaq',
  'kbTutorial', 'kbPolicy', 'kbCreate', 'kbFromWo', 'kbFromWoPlaceholder', 'kbDeleteConfirm',
  'kbCreateTitle', 'kbContent', 'kbVisibility', 'kbVisibilityPublic', 'kbVisibilityInternal',
  'kbStatus', 'kbStatusDraft', 'kbStatusPublished', 'kbStatusArchived', 'kbSave', 'kbPublishedAt',
  'kbViewCount', 'kbAuthor', 'kbCreated', 'kbUpdated', 'kbDeleted', 'kbInternalOnly',
  'kbCategory', 'kbCategoryPlaceholder', 'empty', 'loading', 'search', 'confirm', 'cancel'
];
const CATS = ['all', 'guide', 'faq', 'tutorial', 'policy'];
const CAT_KEYS = { all: 'kbAll', guide: 'kbGuide', faq: 'kbFaq', tutorial: 'kbTutorial', policy: 'kbPolicy' };
const STATUS_KEYS = { draft: 'kbStatusDraft', published: 'kbStatusPublished', archived: 'kbStatusArchived' };
const VIS_KEYS = { public: 'kbVisibilityPublic', internal: 'kbVisibilityInternal' };

Page({
  data: {
    i18n: {}, list: [], total: 0, loading: true, keyword: '', category: 'all', page: 1,
    cats: [], editing: false, editId: '', form: { title: '', category: 'guide', visibility: 'public', status: 'draft', content: '' },
    visOptions: [], statusOptions: [], catOptions: [], showForm: false, fromWo: false, woId: ''
  },

  onLoad() {
    apply(this, KNOWLEDGE_KEYS);
    this.setData({
      cats: CATS.map((c) => ({ key: c, label: t(CAT_KEYS[c]) })),
      catOptions: CATS.filter((c) => c !== 'all').map((c) => ({ key: c, label: t(CAT_KEYS[c]) })),
      visOptions: [
        { key: 'public', label: t('kbVisibilityPublic') },
        { key: 'internal', label: t('kbVisibilityInternal') }
      ],
      statusOptions: ['draft', 'published', 'archived'].map((s) => ({ key: s, label: t(STATUS_KEYS[s]) }))
    });
  },
  onShow() { apply(this, KNOWLEDGE_KEYS); this.loadList(); },

  loadList() {
    this.setData({ loading: true });
    callFunction('knowledge', {
      action: 'knowledge.list', page: 1, page_size: 20,
      category: this.data.category === 'all' ? '' : this.data.category,
      keyword: this.data.keyword
    }).then((r) => {
      this.setData({ loading: false });
      if (r && r.code === 0) {
        const list = (r.data.list || []).map((x) => ({
          ...x,
          cat_label: t(CAT_KEYS[x.category] || x.category),
          status_label: t(STATUS_KEYS[x.status] || x.status),
          vis_label: t(VIS_KEYS[x.visibility] || x.visibility),
          updated_text: fmt(x.updated_at)
        }));
        this.setData({ list, total: r.data.total || 0 });
      }
    });
  },

  onKeyword(e) { this.setData({ keyword: e.detail.value }); },
  onSearch() { this.loadList(); },
  onCategory(e) {
    this.setData({ category: e.currentTarget.dataset.key });
    this.loadList();
  },

  onOpenDetail(e) {
    wx.navigateTo({ url: '/pages/knowledge-detail/knowledge-detail?id=' + e.currentTarget.dataset.id });
  },

  onCreate() {
    this.setData({ editing: true, editId: '', showForm: true, fromWo: false, woId: '',
      form: { title: '', category: 'guide', visibility: 'public', status: 'draft', content: '' } });
  },
  onEdit(e) {
    const item = e.currentTarget.dataset.item;
    this.setData({ editing: true, editId: item._id, showForm: true, fromWo: false, woId: '',
      form: { title: item.title, category: item.category, visibility: item.visibility, status: item.status, content: item.content } });
  },
  onFromWo() {
    this.setData({ editing: true, editId: '', showForm: true, fromWo: true, woId: '',
      form: { title: '', category: 'guide', visibility: 'public', status: 'draft', content: '' } });
  },
  onCloseForm() { this.setData({ showForm: false }); },

  onFTitle(e) { this.setData({ 'form.title': e.detail.value }); },
  onFContent(e) { this.setData({ 'form.content': e.detail.value }); },
  onFCategory(e) { this.setData({ 'form.category': e.currentTarget.dataset.key }); },
  onFVisibility(e) { this.setData({ 'form.visibility': e.currentTarget.dataset.key }); },
  onFStatus(e) { this.setData({ 'form.status': e.currentTarget.dataset.key }); },
  onWoId(e) { this.setData({ woId: e.detail.value }); },

  onSave() {
    const f = this.data.form;
    if (!(f.title || '').trim()) { wx.showToast({ title: t('kbCreateTitle'), icon: 'none' }); return; }
    if (!(f.content || '').trim()) { wx.showToast({ title: t('kbContent'), icon: 'none' }); return; }
    const action = this.data.editId ? 'knowledge.update' : 'knowledge.create';
    const payload = { action, title: f.title, category: f.category, visibility: f.visibility, status: f.status, content: f.content, tags: [] };
    if (this.data.editId) payload.article_id = this.data.editId;
    callFunction('knowledge', payload).then((r) => {
      if (r && r.code === 0) {
        wx.showToast({ title: t(this.data.editId ? 'kbUpdated' : 'kbCreated'), icon: 'success' });
        this.setData({ showForm: false, editing: false });
        this.loadList();
      }
    });
  },

  onFromWoSubmit() {
    const woId = (this.data.woId || '').trim();
    const f = this.data.form;
    if (!woId) { wx.showToast({ title: t('kbFromWoPlaceholder'), icon: 'none' }); return; }
    if (!(f.title || '').trim()) { wx.showToast({ title: t('kbCreateTitle'), icon: 'none' }); return; }
    callFunction('knowledge', {
      action: 'knowledge.from_wo', work_order_id: woId,
      title: f.title, category: f.category, visibility: f.visibility
    }).then((r) => {
      if (r && r.code === 0) {
        wx.showToast({ title: t('kbCreated'), icon: 'success' });
        this.setData({ showForm: false, editing: false, fromWo: false });
        this.loadList();
      }
    });
  },

  onDelete(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: t('confirm'), content: t('kbDeleteConfirm'), confirmColor: '#E5484D',
      success: (res) => {
        if (!res.confirm) return;
        callFunction('knowledge', { action: 'knowledge.delete', article_id: id }).then((r) => {
          if (r && r.code === 0) {
            wx.showToast({ title: t('kbDeleted'), icon: 'success' });
            this.loadList();
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
  return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
}

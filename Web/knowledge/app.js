/**
 * Web/knowledge/app.js — 管理端知识库（V3.1 阶段8-3）
 * 功能：文章列表/搜索/分类筛选、新建/编辑/删除、从工单沉淀案例
 * 安全红线：
 *   - 前端零密钥：不出现任何密钥/数据库配置
 *   - 会话：复用 login Token（localStorage app_session），随请求透传 _token + _source='web'
 *   - 越权防护：服务端校验 KNOWLEDGE_CREATE/UPDATE/DELETE/FROM_WO 权限；客户视角列表/详情仅返回 public+published
 */
(function () {
  'use strict';

  var API_BASE = '/api'; // 云函数 HTTP 触发网关占位，正式部署时替换
  var $ = function (id) { return document.getElementById(id); };
  var state = { keyword: '', category: '', editId: '' };

  var CATS = [
    { key: '', label: '全部' }, { key: 'guide', label: '使用指南' },
    { key: 'faq', label: '常见问题' }, { key: 'tutorial', label: '操作教程' }, { key: 'policy', label: '政策说明' }
  ];

  function session() {
    try { return JSON.parse(localStorage.getItem('app_session') || 'null'); } catch (e) { return null; }
  }
  function api(action, payload) {
    var s = session();
    var body = Object.assign({ action: action, _source: 'web' }, payload || {});
    if (s && s.token) body._token = s.token;
    return fetch(API_BASE + '/knowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (res.code === 401) { showErr('会话已过期，请重新登录'); setTimeout(function () { window.location.href = '../login/index.html'; }, 800); }
      return res;
    });
  }
  function showErr(msg) { var e = $('err'); e.textContent = msg; e.classList.remove('hidden'); }
  function hideErr() { $('err').classList.add('hidden'); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(d) {
    if (!d) return '-';
    var dt = new Date(d), p = function (n) { return String(n).padStart(2, '0'); };
    return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
  }
  function catLabel(k) { var c = CATS.find(function (x) { return x.key === k; }); return c ? c.label : k; }

  function renderCats() {
    $('cats').innerHTML = CATS.map(function (c) {
      return '<span class="chip' + (state.category === c.key ? ' on' : '') + '" data-k="' + c.key + '">' + c.label + '</span>';
    }).join('');
  }
  $('cats').addEventListener('click', function (e) {
    var chip = e.target.closest('.chip');
    if (!chip) return;
    state.category = chip.getAttribute('data-k');
    renderCats();
    loadList();
  });

  function loadList() {
    api('knowledge.list', { page: 1, page_size: 50, category: state.category, keyword: state.keyword }).then(function (res) {
      if (res.code !== 0) { showErr(res.msg || '加载失败'); return; }
      var list = res.data.list || [];
      var box = $('list');
      if (!list.length) { box.innerHTML = '<div class="empty">暂无文章</div>'; return; }
      box.innerHTML = list.map(function (it) {
        return '<div class="card">' +
          '<span class="kb-title">' + esc(it.title) + '</span>' +
          '<span class="kb-vis vis-' + esc(it.visibility) + '">' + (it.visibility === 'internal' ? '内部可见' : '客户可见') + '</span>' +
          '<span class="kb-meta">' + esc(catLabel(it.category)) + ' · ' + esc(it.status) + ' · 浏览 ' + (it.view_count || 0) + ' · ' + fmt(it.updated_at) + '</span>' +
          '<button class="op" data-act="edit" data-id="' + esc(it._id) + '">编辑</button>' +
          '<button class="op danger" data-act="del" data-id="' + esc(it._id) + '">删除</button>' +
          '</div>';
      }).join('');
    });
  }

  $('list').addEventListener('click', function (e) {
    var btn = e.target.closest('.op');
    if (!btn) return;
    var id = btn.getAttribute('data-id');
    var act = btn.getAttribute('data-act');
    if (act === 'del') {
      if (!confirm('确认删除该文章？')) return;
      api('knowledge.delete', { article_id: id }).then(function (res) {
        if (res.code === 0) { loadList(); } else { showErr(res.msg || '删除失败'); }
      });
    } else if (act === 'edit') {
      api('knowledge.detail', { article_id: id }).then(function (res) {
        if (res.code !== 0) { showErr(res.msg || '加载失败'); return; }
        var a = res.data;
        state.editId = id;
        $('formTitle').textContent = '编辑文章';
        $('fTitle').value = a.title || '';
        $('fCategory').value = a.category || 'guide';
        $('fVisibility').value = a.visibility || 'public';
        $('fStatus').value = a.status || 'draft';
        $('fContent').value = a.content || '';
        $('formBox').classList.remove('hidden');
        hideErr();
      });
    }
  });

  $('btnSearch').addEventListener('click', function () { state.keyword = $('keyword').value.trim(); loadList(); });
  $('keyword').addEventListener('keydown', function (e) { if (e.key === 'Enter') { state.keyword = this.value.trim(); loadList(); } });

  function openNew() {
    state.editId = '';
    $('formTitle').textContent = '新建文章';
    $('fTitle').value = ''; $('fCategory').value = 'guide'; $('fVisibility').value = 'public';
    $('fStatus').value = 'draft'; $('fContent').value = '';
    $('formBox').classList.remove('hidden');
    $('fromWoBox').classList.add('hidden');
    hideErr();
  }
  $('btnNew').addEventListener('click', openNew);
  $('btnCancel').addEventListener('click', function () { $('formBox').classList.add('hidden'); });
  $('btnSave').addEventListener('click', function () {
    var action = state.editId ? 'knowledge.update' : 'knowledge.create';
    var payload = {
      title: $('fTitle').value.trim(), category: $('fCategory').value,
      visibility: $('fVisibility').value, status: $('fStatus').value, content: $('fContent').value, tags: []
    };
    if (state.editId) payload.article_id = state.editId;
    if (!payload.title || !payload.content) { showErr('标题与正文不能为空'); return; }
    api(action, payload).then(function (res) {
      if (res.code === 0) { $('formBox').classList.add('hidden'); state.editId = ''; loadList(); }
      else { showErr(res.msg || '保存失败'); }
    });
  });

  $('btnFromWo').addEventListener('click', openFromWo);

  function openFromWo() {
    $('fWoId').value = ''; $('fWoTitle').value = ''; $('fWoCategory').value = 'guide';
    $('formBox').classList.add('hidden');
    $('fromWoBox').classList.remove('hidden');
    hideErr();
  }


  $('fromWoBox').addEventListener('click', function (e) {
    if (e.target.id === 'btnFromWoCancel') { $('fromWoBox').classList.add('hidden'); return; }
    if (e.target.id === 'btnFromWoSubmit') {
      var woId = $('fWoId').value.trim();
      var title = $('fWoTitle').value.trim();
      var category = $('fWoCategory').value;
      if (!woId || !title) { showErr('工单号与文章标题不能为空'); return; }
      api('knowledge.from_wo', { work_order_id: woId, title: title, category: category, visibility: 'public' }).then(function (res) {
        if (res.code === 0) { $('fromWoBox').classList.add('hidden'); loadList(); }
        else { showErr(res.msg || '沉淀失败'); }
      });
    }
  });

  renderCats();
  loadList();
})();

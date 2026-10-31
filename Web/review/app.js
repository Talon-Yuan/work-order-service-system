/**
 * Web/review/app.js — 管理端服务评价统计与记录（V3.1 阶段8-2）
 * 安全红线：
 *   - 前端零密钥：不出现任何密钥/数据库配置
 *   - 会话：复用 login 签发 Token（localStorage app_session），随请求透传 _token + _source='web'
 *   - 越权防护：服务端按角色裁剪（客户无 EVAL_STATS 权限时 stats 返回 403，本页为管理端页面仅内部角色使用）
 * 对接说明：正式环境将 API_BASE 指向云函数 HTTP 触发网关；云函数收到 event._source='web' 且带 _token 时走 Web 会话校验。
 */
(function () {
  'use strict';

  var API_BASE = 'https://cloud-survice-d6gwxx7i906fb6b20-1521641960.ap-shanghai.app.tcloudbase.com'; // 云函数 HTTP 触发网关（无密钥）
  var $ = function (id) { return document.getElementById(id); };

  function session() {
    try { return JSON.parse(localStorage.getItem('app_session') || 'null'); } catch (e) { return null; }
  }
  function api(action, payload) {
    var s = session();
    var body = Object.assign({ action: action, _source: 'web' }, payload || {});
    if (s && s.token) body._token = s.token;
    return fetch(API_BASE + '/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (res.code === 401) { showErr('会话已过期，请重新登录'); setTimeout(function () { window.location.href = '../login/index.html'; }, 800); }
      return res;
    });
  }
  function showErr(msg) { var e = $('err'); e.textContent = msg; e.classList.remove('hidden'); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(d) {
    if (!d) return '-';
    var dt = new Date(d), p = function (n) { return String(n).padStart(2, '0'); };
    return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate()) + ' ' + p(dt.getHours()) + ':' + p(dt.getMinutes());
  }

  function loadStats() {
    api('eval.stats').then(function (res) {
      if (res.code !== 0) return; // 无权限时隐藏统计区（服务端已拦截）
      var d = res.data;
      $('statsWrap').classList.remove('hidden');
      $('stAvg').textContent = Number(d.avg_rating || 0).toFixed(1);
      $('stTotal').textContent = d.total || 0;
      var html = '';
      [5, 4, 3, 2, 1].forEach(function (r) {
        var pct = d.total ? Math.round((d.dist[r] || 0) / d.total * 100) : 0;
        html += '<div class="dist"><span>' + r + '★</span><div class="bar"><div class="fill" style="width:' + pct + '%"></div></div><span>' + (d.dist[r] || 0) + '</span></div>';
      });
      $('stDist').innerHTML = html;
    });
  }

  function loadList() {
    api('eval.list', { page: 1, page_size: 50 }).then(function (res) {
      if (res.code !== 0) { showErr(res.msg || '加载失败'); return; }
      var list = res.data.list || [];
      var box = $('list');
      if (!list.length) { box.innerHTML = '<div class="empty">暂无评价记录</div>'; return; }
      box.innerHTML = list.map(function (it) {
        var tags = (it.tags || []).map(function (tg) { return '<span class="tag">' + esc(tg) + '</span>'; }).join('');
        var content = it.content ? '<div class="content">' + esc(it.content) + '</div>' : '';
        return '<div class="card"><div class="head">' +
          '<span class="rating">' + esc(it.rating) + '★</span>' +
          '<span class="time">' + esc(it.work_order_id || '') + ' · ' + fmt(it.created_at) + '</span>' +
          '</div><div class="tags">' + tags + '</div>' + content + '</div>';
      }).join('');
    });
  }

  loadStats();
  loadList();
})();

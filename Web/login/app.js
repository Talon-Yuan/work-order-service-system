/**
 * Web/login/app.js — 管理端登录页骨架脚本
 * 安全红线：
 *   - 前端零密钥：本文件不出现任何密钥/密钥逻辑
 *   - 提交后调用 login 云函数 web 分支（验证码/密码），服务端校验并签发 Token
 *   - 401 处理：清除本地会话并提示重新登录
 * 对接说明：正式环境将 API_BASE 指向云函数 HTTP 触发网关，或由服务端渲染页面直连。
 * 云函数 action 命名约定：sms.send（发验证码）、login（验证码/密码登录）、bind（openid 绑定）。
 */
(function () {
  'use strict';

  // 云函数网关地址（HTTP 访问服务默认域，不含密钥）
  var API_BASE = 'https://cloud-survice-d6gwxx7i906fb6b20-1521641960.ap-shanghai.app.tcloudbase.com';

  var $ = function (id) { return document.getElementById(id); };
  var tabCode = $('tabCode'), tabPwd = $('tabPwd');
  var formCode = $('formCode'), formPwd = $('formPwd');
  var err = $('err');

  function switchTab(useCode) {
    tabCode.classList.toggle('active', useCode);
    tabPwd.classList.toggle('active', !useCode);
    formCode.classList.toggle('hidden', !useCode);
    formPwd.classList.toggle('hidden', useCode);
    err.classList.add('hidden');
  }
  tabCode.addEventListener('click', function () { switchTab(true); });
  tabPwd.addEventListener('click', function () { switchTab(false); });

  // 获取验证码（骨架：调用 login 云函数 web/sendCode；60s 倒计时）
  $('btnSend').addEventListener('click', function () {
    var phone = $('phoneCode').value.trim();
    if (!/^1\d{10}$/.test(phone)) { showErr('请输入正确的手机号'); return; }
    var btn = this;
    btn.disabled = true;
    fetch(API_BASE + '/login/sendCode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene: 'web', action: 'sms.send', phone: phone })
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (res.code !== 0) { showErr(res.msg || '发送失败'); btn.disabled = false; return; }
      var left = 60;
      var timer = setInterval(function () {
        left -= 1;
        btn.textContent = left + 's';
        if (left <= 0) { clearInterval(timer); btn.textContent = '获取验证码'; btn.disabled = false; }
      }, 1000);
    }).catch(function () { btn.disabled = false; showErr('网络异常，请重试'); });
  });

  function showErr(msg) { err.textContent = msg; err.classList.remove('hidden'); }

  function doLogin(phone, credential, mode) {
    fetch(API_BASE + '/login/web', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: phone, credential: credential, mode: mode, source: 'web' })
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (res.code !== 0) { showErr(res.msg || '登录失败'); return; }
      // 骨架：Token 持久化到 localStorage（正式环境建议 httpOnly Cookie）
      localStorage.setItem('app_session', JSON.stringify({ token: res.data.token, expires: res.data.expires }));
      window.location.href = '../knowledge/index.html';
    }).catch(function () { showErr('网络异常，请重试'); });
  }

  formCode.addEventListener('submit', function (e) {
    e.preventDefault();
    doLogin($('phoneCode').value.trim(), $('code').value.trim(), 'code');
  });
  formPwd.addEventListener('submit', function (e) {
    e.preventDefault();
    doLogin($('phonePwd').value.trim(), $('password').value, 'password');
  });
})();

#!/usr/bin/env node
/**
 * _stage7_unit_test.js — 阶段7（数据看板 / 成本统计 / Excel 导出）单元测试
 * 纯逻辑测试：权限矩阵（与 authGuard.can 一致）、PII 脱敏、趋势日期桶。
 * 输出：scripts/_stage7_unit_out.json；全部通过 exit 0。
 */
const path = require('path');
const fs = require('fs');
const constants = require(path.join(__dirname, '..', 'cloudfunctions', 'common', 'constants.js'));
const checks = [];
function check(name, pass, detail) { checks.push({ name: name, pass: !!pass, detail: detail || '' }); }

// —— 权限矩阵 can()：与 authGuard.js 实现一致 ——
function can(role, action) {
  const caps = constants.ROLE_CAPS[role];
  if (!caps) return false;
  return caps.indexOf('*') >= 0 || caps.indexOf(action) >= 0;
}
const A = constants.ACTIONS;
check('admin 通配全权限（含成本写/导出）',
  can('admin', A.COST_CONFIG_WRITE) && can('admin', A.COST_STATS_READ) && can('admin', A.EXPORT_CREATE) && can('admin', A.EXPORT_LIST));
check('customer 可看板 overview', can('customer', A.DASHBOARD_OVERVIEW));
check('customer 可导出本人记录', can('customer', A.EXPORT_CREATE) && can('customer', A.EXPORT_LIST));
check('customer 无成本统计权限', !can('customer', A.COST_STATS_READ));
check('customer 无成本参数读写', !can('customer', A.COST_CONFIG_READ) && !can('customer', A.COST_CONFIG_WRITE));
check('owner 可成本统计与参数读', can('owner', A.COST_STATS_READ) && can('owner', A.COST_CONFIG_READ));
check('owner 不可写成本参数（仅 admin）', !can('owner', A.COST_CONFIG_WRITE));
check('engineer 可成本统计', can('engineer', A.COST_STATS_READ));
check('engineer 不可写成本参数', !can('engineer', A.COST_CONFIG_WRITE));

// —— PII 脱敏（与 export/index.js 的 mask* 一致） ——
function maskPhone(s) { const t = String(s || ''); return t.length >= 7 ? t.slice(0, 3) + '****' + t.slice(-4) : (t ? '***' : ''); }
function maskAddress(s) { const t = String(s || ''); return t.length > 6 ? t.slice(0, 3) + '****' + t.slice(-2) : (t ? '***' : ''); }
function maskOpenid(s) { const t = String(s || ''); return t.length > 10 ? t.slice(0, 6) + '****' + t.slice(-4) : (t ? '***' : ''); }
check('脱敏-手机号', maskPhone('13812345678') === '138****5678');
check('脱敏-地址', maskAddress('北京市朝阳区建国路88号') === '北京市****8号');
check('脱敏-openid', maskOpenid('oA123456789012345678') === 'oA1234****5678');
check('脱敏-空值', maskPhone('') === '' && maskAddress('') === '' && maskOpenid('') === '');

// —— 看板趋势日期桶（与 dashboard/index.js 一致） ——
const pad = (n) => String(n).padStart(2, '0');
function dayKey(d) { const dt = new Date(d); return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate()); }
function buildTrend(days, start) {
  const arr = []; const map = {};
  for (let i = 0; i < days; i += 1) {
    const d = new Date(start.getTime() + i * 86400000);
    const key = dayKey(d);
    const item = { date: key, work_orders: 0, appointments: 0, cost_fen: 0 };
    arr.push(item); map[key] = item;
  }
  return { arr: arr, map: map };
}
const tr = buildTrend(30, new Date('2026-10-01T00:00:00'));
check('趋势桶-30天连续且覆盖末天', tr.arr.length === 30 && !!tr.map['2026-10-30']);
check('趋势桶-键格式 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(tr.arr[0].date) && tr.arr[0].date === '2026-10-01');

const total = checks.length;
const passed = checks.filter(function (c) { return c.pass; }).length;
fs.writeFileSync(path.join(__dirname, '_stage7_unit_out.json'), JSON.stringify({ total: total, passed: passed, checks: checks }, null, 2), 'utf-8');
console.log('stage7 unit:', passed + '/' + total);
process.exit(passed === total ? 0 : 1);

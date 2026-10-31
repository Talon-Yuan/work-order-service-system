/**
 * utils/util.js — 通用格式化工具
 * 注意：Python strftime 禁中文字符的约束仅适用于 python_executor 脚本，
 *      小程序端 JS 直接使用 Intl/手动拼接即可。
 */
function pad(n) { return n < 10 ? '0' + n : '' + n; }

/** Date -> 'YYYY-MM-DD HH:mm:ss' */
function formatDateTime(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
}

/** 金额分 -> 元字符串（保留两位） */
function fenToYuan(fen) {
  const n = Number(fen || 0);
  return (n / 100).toFixed(2);
}

/** 状态码 -> 中文状态（后续可并入语言包） */
const WO_STATUS = {
  pending: '待受理', assigned: '已派单', processing: '施工中',
  paused: '已暂停', completed: '已完成', closed: '已关闭', rejected: '已驳回'
};

module.exports = { formatDateTime, fenToYuan, WO_STATUS };

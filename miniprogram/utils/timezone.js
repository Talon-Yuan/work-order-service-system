/**
 * utils/timezone.js — 时间换算（阶段 3，对应项目书 3-2 / 16.6）
 * 设计：
 *  - 服务端统一以北京时间（Asia/Shanghai, GMT+8）存储预约/工单时间
 *  - 客户端用 Intl.DateTimeFormat 按用户所在地时区换算展示（DST 自动处理）
 *  - 提供双向换算：北京时间 -> 本地展示；本地选择 -> 北京时间落库
 * 安全红线：时区换算纯客户端展示能力，不改变服务端存储；无任何密钥。
 */
const { TIMEZONE_CITIES } = require('./timezone-cities');

const BEIJING_TZ = 'Asia/Shanghai';

/** 查字典：按城市名（中/英）或 tz 定位 */
function lookup(ident) {
  if (!ident) return null;
  for (const c of TIMEZONE_CITIES) {
    if (c.tz === ident || c.city === ident || c.city_zh === ident) return c;
  }
  return null;
}

/** 获取某时区在指定时刻的实际 UTC 偏移（分钟），DST 自动生效 */
function getOffsetMinutes(tz, date) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const parts = dtf.formatToParts(date || new Date());
    const m = {};
    parts.forEach((p) => { m[p.type] = p.value; });
    const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour % 24, +m.minute, +m.second);
    return Math.round((asUTC - (date || new Date()).getTime()) / 60000);
  } catch (e) {
    const c = lookup(tz);
    return c ? c.offset_minutes : 480;
  }
}

/** 指定时区格式化：'YYYY-MM-DD HH:mm' */
function formatInTimeZone(date, tz, opts) {
  const o = Object.assign({
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  }, opts || {});
  try {
    const dtf = new Intl.DateTimeFormat('zh-CN', o);
    const parts = dtf.formatToParts(date);
    const m = {};
    parts.forEach((p) => { m[p.type] = p.value; });
    return m.year + '-' + m.month + '-' + m.day + ' ' + m.hour + ':' + m.minute;
  } catch (e) {
    return date.toString();
  }
}

/** 解析 'YYYY-MM-DD HH:mm'（北京时间语义）-> Date（绝对时刻） */
function parseBeijing(datetimeStr) {
  const s = String(datetimeStr || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return null;
  const iso = m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':00+08:00';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** 北京时间 -> 目标时区：输入 'YYYY-MM-DD HH:mm'（北京），输出目标时区 'YYYY-MM-DD HH:mm' */
function beijingToLocal(beijingDatetime, toTz) {
  const d = parseBeijing(beijingDatetime);
  if (!d) return '';
  return formatInTimeZone(d, toTz || BEIJING_TZ);
}

/** 目标时区 -> 北京时间：输入本地 'YYYY-MM-DD HH:mm' 与本地时区，输出北京 'YYYY-MM-DD HH:mm' */
function localToBeijing(localDatetime, fromTz) {
  const s = String(localDatetime || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return '';
  const tz = fromTz || BEIJING_TZ;
  try {
    // 反解：先按目标时区解释为绝对时刻，再格式化为北京
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const sample = dtf.formatToParts(new Date());
    const mm = {};
    sample.forEach((p) => { mm[p.type] = p.value; });
    const guess = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0) - (getOffsetMinutes(tz, new Date()) * 60000));
    // 两次逼近修正 DST 边界（naive 方式已足够骨架用途；边界由服务端权威校验）
    const offset = getOffsetMinutes(tz, guess);
    const fixed = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0) - (offset * 60000));
    return formatInTimeZone(fixed, BEIJING_TZ);
  } catch (e) {
    return '';
  }
}

/** 展示预约时段：北京日期+槽位 -> 本地 日期+时段（如 '09:00-10:30'） */
function showAppointmentWindow(date, slot, toTz) {
  if (!date || !slot) return { date: date || '', slot: slot || '' };
  const range = String(slot).split('-');
  if (range.length !== 2) return { date: date || '', slot: slot || '' };
  const startB = parseBeijing(date + ' ' + range[0]);
  if (!startB) return { date: date || '', slot: slot || '' };
  const startL = formatInTimeZone(startB, toTz || BEIJING_TZ);
  const endB = parseBeijing(date + ' ' + range[1]);
  const endL = endB ? formatInTimeZone(endB, toTz || BEIJING_TZ) : '';
  return { date: startL.slice(0, 10), slot: startL.slice(11) + '-' + endL.slice(11) };
}

/** 本地时段回填北京日期：选本地 'YYYY-MM-DD HH:mm-HH:mm' 与本地时区，回北京槽位 */
function toBeijingWindow(localDate, localSlot, fromTz) {
  if (!localDate || !localSlot) return { date: localDate || '', slot: localSlot || '' };
  const range = String(localSlot).split('-');
  if (range.length !== 2) return { date: localDate || '', slot: localSlot || '' };
  const start = localToBeijing(localDate + ' ' + range[0], fromTz);
  const end = localToBeijing(localDate + ' ' + range[1], fromTz);
  if (!start || !end) return { date: localDate || '', slot: localSlot || '' };
  return { date: start.slice(0, 10), slot: start.slice(11) + '-' + end.slice(11) };
}

/** 是否 RTL 语言（供页面根节点 direction 设置） */
function isRTL(lang) {
  return /^ar(-|$)/.test(lang || '');
}

module.exports = {
  TIMEZONE_CITIES,
  BEIJING_TZ,
  lookup,
  getOffsetMinutes,
  formatInTimeZone,
  parseBeijing,
  beijingToLocal,
  localToBeijing,
  showAppointmentWindow,
  toBeijingWindow,
  isRTL
};

/**
 * security.js — 入参清洗与注入防护
 * 原则：
 *  1. 字段白名单：只保留 spec 中声明的字段，剥离一切未登记字段
 *  2. 类型/长度校验：非法值直接置为默认或抛错
 *  3. NoSQL 注入防护：拒绝以 $ 开头的键（数据库查询运算符注入面）
 */
function cleanInput(obj, spec = {}) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const key of Object.keys(obj)) {
    if (key.startsWith('$')) continue; // 防 NoSQL 查询运算符注入
    const rule = spec[key];
    if (rule === undefined) continue; // 未登记字段一律丢弃
    const val = obj[key];
    const type = rule.type || 'string';
    if (val === undefined || val === null) {
      if (rule.required) throw new Error('MISSING_FIELD:' + key);
      continue;
    }
    if (type === 'string') {
      const s = String(val);
      if (rule.max && s.length > rule.max) throw new Error('FIELD_TOO_LONG:' + key);
      out[key] = s;
    } else if (type === 'number') {
      const n = Number(val);
      if (Number.isNaN(n)) throw new Error('FIELD_TYPE:' + key);
      out[key] = n;
    } else if (type === 'boolean') {
      out[key] = !!val;
    } else if (type === 'array') {
      if (!Array.isArray(val)) throw new Error('FIELD_TYPE:' + key);
      out[key] = val;
    } else if (type === 'object') {
      if (typeof val !== 'object' || Array.isArray(val)) throw new Error('FIELD_TYPE:' + key);
      out[key] = val;
    }
  }
  return out;
}

/** 校验枚举值 */
function inEnum(val, list) {
  return list.includes(val);
}

module.exports = { cleanInput, inEnum };

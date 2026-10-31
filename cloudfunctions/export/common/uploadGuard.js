/**
 * uploadGuard.js — 文件上传安全公共模块（V3.1 阶段5，任务 5-2）
 * 安全点逐条落地：
 *  1. 魔数校验：忽略扩展名，按文件头字节判断真实类型（jpg/png/webp），伪装扩展名一律拒绝
 *  2. 大小限制：图片 ≤ 5MB（服务端强校验，前端限制仅体验层）
 *  3. 内容安全扫描：文本 msgSecCheck / 图片 imgSecCheck（微信内容安全），违规拒绝并记录；
 *     扫描服务不可用时默认 fail-closed（拒绝上传），可经 system_config 配置 fail_open 兜底
 *  4. 文件名清洗：去除路径分隔符/控制字符/危险扩展名，重命名随机名，防路径遍历
 *  5. 云存储私有读：cloudPath 随机化，仅云函数写入，授权用户经 getTempFileURL 获取临时链接
 *  6. 频率与容量限制：checkRateLimit 频率；upload_logs 当日累计容量配额（system_config 可配）
 */
const cloud = require('wx-server-sdk');
const { checkRateLimit } = require('./rateLimit');

/** 允许上传的图片类型（魔数表） */
const MAGIC_MAP = {
  jpg:  [0xFF, 0xD8, 0xFF],            // JPEG (FF D8 FF)
  png:  [0x89, 0x50, 0x4E, 0x47],      // PNG (89 50 4E 47)
  webp: [0x52, 0x49, 0x46, 0x46]       // WEBP (RIFF....WEBP，需再校验 'WEBP')
};

/** 扩展名白名单（与魔数结果匹配） */
const ALLOWED_EXT = ['jpg', 'jpeg', 'png', 'webp'];

/** 单文件大小上限：5MB */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** 默认单用户容量配额：50MB */
const DEFAULT_QUOTA_MB = 50;

/** 默认上传频率：每用户每分钟 10 次 */
const DEFAULT_FREQ_PER_MIN = 10;

/**
 * 魔数校验：按真实文件头判断类型
 * @param {Buffer} buf 文件二进制
 * @returns {string|null} 真实扩展名（jpg/png/webp），不匹配返回 null
 */
function detectImageType(buf) {
  if (!buf || buf.length < 8) return null;
  for (const ext of ['jpg', 'png']) {
    const magic = MAGIC_MAP[ext];
    let hit = true;
    for (let i = 0; i < magic.length; i++) {
      if (buf[i] !== magic[i]) { hit = false; break; }
    }
    if (hit) return ext === 'jpg' ? 'jpg' : 'png';
  }
  // WebP: RIFF(4) + size(4) + 'WEBP'(4)
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return 'webp';
  }
  return null;
}

/**
 * 文件名清洗：去路径分隔符/控制字符/危险后缀，仅保留可打印名
 * 返回 null 表示文件名非法（路径遍历/空名）
 */
function sanitizeFileName(name) {
  if (typeof name !== 'string') return null;
  // 1) 去路径分隔符（反斜杠/正斜杠/盘符冒号）——防路径遍历
  let cleaned = name.replace(/[\\/:\x00-\x1f<>"|?*]/g, '_');
  // 2) 剥离扩展名（扩展名以魔数结果为准，不信任用户后缀）
  const dot = cleaned.lastIndexOf('.');
  if (dot > 0) cleaned = cleaned.slice(0, dot);
  // 3) 去首尾空白与控制字符，截断
  cleaned = cleaned.replace(/[\s\x00-\x1f]+/g, '_').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, 60);
}

/**
 * 内容安全扫描（微信内容安全 API）
 * @param {object} cloudInstance 已 init 的 cloud
 * @param {object} opts { text?, imageBuffer?, contentType?, contentName? }
 * @returns {Promise<{ok:boolean, errcode?:number, errmsg?:string}>}
 */
async function checkContentSafe(cloudInstance, opts) {
  // system_config 可配置 fail-open 兜底；默认 fail-closed：API 不可用即拒绝
  const failOpen = opts.failOpen === true;
  try {
    if (opts.imageBuffer && opts.imageBuffer.length > 0) {
      const res = await cloudInstance.openapi.security.imgSecCheck({
        media: { contentType: opts.contentType || 'image/jpeg', value: opts.imageBuffer }
      });
      if (res && res.errCode === 0) return { ok: true };
      return { ok: false, errcode: res && res.errCode, errmsg: res && res.errMsg };
    }
    if (opts.text) {
      const res = await cloudInstance.openapi.security.msgSecCheck({ content: opts.text });
      if (res && res.errCode === 0) return { ok: true };
      return { ok: false, errcode: res && res.errCode, errmsg: res && res.errMsg };
    }
    return { ok: true };
  } catch (e) {
    // 扫描服务不可用/未开通：默认 fail-closed 拒绝（安全优先）
    if (failOpen) return { ok: true, warning: 'content_check_unavailable_fail_open' };
    return { ok: false, errcode: -1, errmsg: 'content_check_unavailable' };
  }
}

/**
 * 读取上传配额与频率配置（system_config，管理员可配）
 */
async function readUploadConfig(db) {
  let quotaMb = DEFAULT_QUOTA_MB;
  let freqPerMin = DEFAULT_FREQ_PER_MIN;
  try {
    const res = await db.collection('system_config')
      .where({ _id: 'upload.limit' }).limit(1).get();
    if (res.data && res.data.length) {
      const v = res.data[0].value || {};
      if (typeof v.per_user_quota_mb === 'number' && v.per_user_quota_mb > 0) quotaMb = v.per_user_quota_mb;
      if (typeof v.freq_per_min === 'number' && v.freq_per_min > 0) freqPerMin = v.freq_per_min;
    }
  } catch (e) { /* 配置缺失时用默认值 */ }
  return { quotaMb, freqPerMin };
}

/**
 * 上传频率限制（内存级滑动窗口）
 */
function checkUploadFreq(openid, freqPerMin) {
  return checkRateLimit('upload', openid, freqPerMin).ok === true;
}

/**
 * 单用户容量限制：查询 upload_logs 当日累计字节数
 * @returns {Promise<{ok:boolean, usedBytes:number, quotaBytes:number}>}
 */
async function checkUserQuota(db, openid, quotaMb) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  let usedBytes = 0;
  try {
    const res = await db.collection('upload_logs')
      .where({ uploader_openid: openid, created_at: db.command.gte(start) })
      .field({ size_bytes: true })
      .limit(1000)
      .get();
    res.data.forEach((r) => { usedBytes += Number(r.size_bytes || 0); });
  } catch (e) { /* 集合不存在时按 0 处理 */ }
  const quotaBytes = quotaMb * 1024 * 1024;
  return { ok: usedBytes < quotaBytes, usedBytes, quotaBytes };
}

module.exports = {
  MAGIC_MAP, ALLOWED_EXT, MAX_FILE_BYTES,
  DEFAULT_QUOTA_MB, DEFAULT_FREQ_PER_MIN,
  detectImageType, sanitizeFileName, checkContentSafe,
  readUploadConfig, checkUploadFreq, checkUserQuota
};

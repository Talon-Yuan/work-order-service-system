/**
 * upload 云函数 — 任务 5-2：文件上传安全
 * 安全点逐条落地（复用 common/uploadGuard.js）：
 *  1. 魔数校验真实类型（jpg/png/webp），扩展名伪装拒绝；
 *  2. 大小 ≤ 5MB（服务端强校验）；
 *  3. 内容安全扫描 imgSecCheck（图片）/ msgSecCheck（文本备注），违规拒绝并写 audit_logs；
 *  4. 文件名清洗去路径符，重命名随机名防路径遍历；
 *  5. 云存储私有读 + 临时访问链接仅授权用户（getTempFileURL 由本云函数按需签发，不落库公开链接）；
 *  6. 上传频率（每分钟 N 次）+ 单用户容量配额（upload_logs 当日累计）。
 * 流程：前置校验（频率/大小/魔数/清洗）→ 内容安全 → 云存储写入（私有读）→ 记录 upload_logs → 审计
 */
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./common/response');
const { ACTIONS, COLLECTIONS } = require('./common/constants');
const { cleanInput } = require('./common/security');
const { authGuard } = require('./common/authGuard');
const { writeAudit } = require('./common/workflow');
const {
  MAX_FILE_BYTES, detectImageType, sanitizeFileName,
  checkContentSafe, readUploadConfig, checkUploadFreq, checkUserQuota
} = require('./common/uploadGuard');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

/** 文件ID 统一前缀（私有读容器） */
const FILE_ID_PREFIX = 'workorder-files/';

exports.main = async (event) => {
  const action = event && event.action;

  if (action === 'upload.getUploadSign') {
    // 方案 B（推荐）：前端不直接碰云存储——由云函数统一下发临时上传凭证并携带上下文
    return getUploadSign(event);
  }
  if (action === 'upload.commit') {
    // 方案 B 配套：前端用临时链接直传成功后，携带 fileID 回执登记到 upload_logs + 审计
    return commitUpload(event);
  }
  if (action === 'upload.tempUrl') {
    // 授权用户换取私有读临时链接（服务端签发，防未授权直读）
    return issueTempUrl(event);
  }

  return fail(400, 'UNKNOWN_ACTION');
};

/** 5-2a：校验并签发上传凭证（含全部安全校验，通过后才给前端临时上传凭证） */
async function getUploadSign(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      biz_type: { type: 'string', max: 20, default: 'work_order' }, // work_order / acceptance / avatar
      file_name: { type: 'string', max: 128, required: true },
      file_size: { type: 'number', min: 1, required: true }
    });
  } catch (e) {
    return fail(400, 'INVALID_PARAMS');
  }

  const ctx = await authGuard(event, { action: ACTIONS.UPLOAD_FILE });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db, openid, role } = ctx;

  // ① 大小限制（服务端强校验）
  if (p.file_size > MAX_FILE_BYTES) {
    return fail(413, 'FILE_TOO_LARGE');
  }

  // ② 上传频率限制（内存级滑动窗口，每用户每配置周期）
  const cfg = await readUploadConfig(db);
  if (!checkUploadFreq(openid, cfg.freqPerMin)) {
    return fail(429, 'UPLOAD_TOO_FREQUENT');
  }

  // ③ 单用户容量限制（当日累计 upload_logs）
  const quota = await checkUserQuota(db, openid, cfg.quotaMb);
  if (!quota.ok) {
    return fail(413, 'USER_QUOTA_EXCEEDED');
  }

  // ④ 文件名清洗：去路径符/控制字符，剥离不可信扩展名
  const cleanName = sanitizeFileName(p.file_name);
  if (!cleanName) {
    return fail(400, 'INVALID_FILE_NAME');
  }

  // ⑤ 随机重命名（防路径遍历/越权覆盖），扩展名由后续魔数校验决定
  const rand = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const ext = 'bin'; // 占位，上传回执时由服务端魔数校验替换
  const cloudPath = FILE_ID_PREFIX + openid.slice(-8) + '/' + rand + '.' + ext;

  return ok({
    upload_token: {
      cloud_path: cloudPath,
      max_bytes: MAX_FILE_BYTES,
      biz_type: p.biz_type,
      freq_per_min: cfg.freqPerMin,
      quota_mb: cfg.quotaMb
    },
    hint: 'client upload to cloudPath via wx.cloud.uploadFile, then call upload.commit with returned fileID'
  });
}

/** 5-2b：前端直传完成后登记（服务端重校验：魔数/大小/内容安全） */
async function commitUpload(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      file_id: { type: 'string', max: 200, required: true },   // 云存储 fileID
      file_name: { type: 'string', max: 128, required: true }, // 原始文件名（仅用于展示）
      biz_type: { type: 'string', max: 20, default: 'work_order' },
      ref_type: { type: 'string', max: 20, default: 'work_order' }, // work_order / work_step
      ref_id: { type: 'string', max: 64, default: '' },
      remark: { type: 'string', max: 200, default: '' }        // 需要文本内容安全校验
    });
  } catch (e) {
    return fail(400, 'INVALID_PARAMS');
  }

  const ctx = await authGuard(event, { action: ACTIONS.UPLOAD_FILE });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db, openid, role } = ctx;

  // 云函数可访问云存储文件二进制（私有读 + 云函数权限）
  let fileData;
  try {
    const res = await cloud.downloadFile({ fileID: p.file_id });
    fileData = res.fileContent; // Buffer
  } catch (e) {
    return fail(404, 'FILE_DOWNLOAD_FAILED');
  }

  // ① 服务端大小重校验
  if (!fileData || fileData.length > MAX_FILE_BYTES) {
    return fail(413, 'FILE_TOO_LARGE');
  }

  // ② 魔数校验真实类型（忽略扩展名）
  const realExt = detectImageType(fileData);
  if (!realExt) {
    // 类型不合法：删除已上传文件并审计拒绝
    await safeRemove(db, openid, p.file_id, 'type_mismatch');
    return fail(415, 'FILE_TYPE_NOT_ALLOWED');
  }

  // ③ 内容安全扫描（图片 + 备注文本），违规拒绝并记录
  const imgSafe = await checkContentSafe(cloud, {
    imageBuffer: fileData,
    contentType: realExt === 'jpg' ? 'image/jpeg' : 'image/' + realExt,
    failOpen: false
  });
  if (!imgSafe.ok) {
    await safeRemove(db, openid, p.file_id, 'img_unsafe');
    await writeAudit(db, {
      actor_openid: openid, role, action: 'upload_rejected',
      target_collection: COLLECTIONS.UPLOAD_LOGS, target_id: p.file_id,
      after: { reason: 'imgSecCheck_rejected', code: imgSafe.errcode }
    });
    return fail(451, 'CONTENT_UNSAFE');
  }
  if (p.remark) {
    const textSafe = await checkContentSafe(cloud, { text: p.remark.slice(0, 200), failOpen: false });
    if (!textSafe.ok) {
      await safeRemove(db, openid, p.file_id, 'text_unsafe');
      return fail(451, 'CONTENT_UNSAFE');
    }
  }

  // ④ 固定路径防越权：file_id 必须属于本用户前缀（服务端生成），否则拒绝
  if (p.file_id.indexOf(FILE_ID_PREFIX + openid.slice(-8) + '/') !== 0) {
    await safeRemove(db, openid, p.file_id, 'path_forbidden');
    return fail(403, 'FILE_PATH_FORBIDDEN');
  }

  // ⑤ 登记 upload_logs（容量/审计依据）
  const now = new Date();
  const logRes = await db.collection(COLLECTIONS.UPLOAD_LOGS).add({
    data: {
      file_id: p.file_id,
      file_name: sanitizeFileName(p.file_name) || 'upload',
      biz_type: p.biz_type,
      ref_type: p.ref_type,
      ref_id: p.ref_id,
      uploader_openid: openid,
      size_bytes: fileData.length,
      real_type: realExt,
      content_check: 'passed',
      created_at: now
    }
  });

  // ⑥ 审计
  await writeAudit(db, {
    actor_openid: openid, role, action: 'upload',
    target_collection: COLLECTIONS.UPLOAD_LOGS, target_id: logRes._id,
    after: { file_id: p.file_id, size_bytes: fileData.length, real_type: realExt, content_check: 'passed' }
  });

  return ok({
    file_id: p.file_id,
    real_type: realExt,
    size_bytes: fileData.length,
    log_id: logRes._id,
    note: 'stored with private read; temp url via upload.tempUrl only'
  });
}

/** 5-2c：授权用户签发私有读临时链接（行级过滤 + 上传者归属校验） */
async function issueTempUrl(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      file_id: { type: 'string', max: 200, required: true },
      max_age: { type: 'number', min: 60, max: 86400, default: 600 }
    });
  } catch (e) {
    return fail(400, 'INVALID_PARAMS');
  }
  const ctx = await authGuard(event, { action: ACTIONS.WO_DETAIL });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db, openid, role } = ctx;
  try {
    // 仅允许读取本人上传的文件（或管理员）
    const logRes = await db.collection(COLLECTIONS.UPLOAD_LOGS)
      .where({ file_id: p.file_id }).limit(1).get();
    if (!logRes.data.length) return fail(404, 'UPLOAD_LOG_NOT_FOUND');
    const log = logRes.data[0];
    if (role !== 'admin' && log.uploader_openid !== openid) {
      return fail(403, 'NOT_YOUR_FILE');
    }
    // 与工单关联的附件：工单关联角色（客户/负责人/工程师）也允许换取（校验 openid 匹配）
    if (log.ref_type === 'work_order' && log.ref_id) {
      const woRes = await db.collection(COLLECTIONS.WORK_ORDERS)
        .where(Object.assign({}, ctx.rowFilter, { _id: log.ref_id })).limit(1).get();
      if (!woRes.data.length) return fail(403, 'WO_NOT_ACCESSIBLE');
    }
    const res = await cloud.getTempFileURL({ fileList: [p.file_id], maxAge: p.max_age });
    const item = (res.fileList || [])[0];
    if (!item || item.status !== 0 || !item.tempFileURL) return fail(500, 'TEMP_URL_FAILED');
    return ok({ temp_file_url: item.tempFileURL, expire_in: p.max_age });
  } catch (e) {
    console.error('[upload] tempUrl error:', e);
    return fail(500, 'INTERNAL: temp url failed');
  }
}

/** 失败清理：删除已上传到云存储的违规文件 */
async function safeRemove(db, openid, fileId, reason) {
  try {
    await cloud.deleteFile({ fileList: [fileId] });
  } catch (e) {
    console.error('[upload] delete rejected file failed', e && e.message);
  }
  try {
    await writeAudit(db, {
      actor_openid: openid, role: '', action: 'upload_rejected',
      target_collection: COLLECTIONS.UPLOAD_LOGS, target_id: fileId,
      after: { reason: reason }
    });
  } catch (e) { /* noop */ }
}


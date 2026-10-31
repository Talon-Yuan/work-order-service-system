/**
 * export 云函数 — 阶段7-3：报表导出 Excel（SheetJS）+ 导出记录与文件访问控制
 *  - 导出场景：workorders（工单清单）/ maintenance_report（维修报表：工单+步骤+验收）/
 *              inventory_flows（备件出入库流水）/ evaluations（评价回访汇总）；
 *  - 安全四要素（项目书 16.2）：① authGuard 行级过滤（导出范围先收敛）；② 二次校验
 *    （逐行归属校验，越权行终止导出）；③ audit_logs 审计；④ checkRateLimit 限流；
 *  - 文件访问控制：Excel 存云存储私有读容器 exports/，数据库仅存 fileID 与元数据；
 *    临时链接按需签发（getTempFileURL），记录级 expire_at 到期后拒绝再次换取链接；
 *    export.get 二次校验 exporter_openid === 本人（或 admin），非本人拒绝；
 *  - 数据脱敏（7-4）：导出前对手机号/地址/openid 等 PII 字段掩码（mask*），客户导出
 *    工单清单不包含成本字段（最小返回）。
 */
const cloud = require('wx-server-sdk');
const XLSX = require('xlsx');
const { ok, fail } = require('./common/response');
const { ACTIONS, COLLECTIONS, WO_STATUS } = require('./common/constants');
const { cleanInput } = require('./common/security');
const { authGuard } = require('./common/authGuard');
const { writeAudit, genNo } = require('./common/workflow');
const { checkRateLimit } = require('./common/rateLimit');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const _ = cloud.database().command;

const EXPORT_TYPES = ['workorders', 'maintenance_report', 'inventory_flows', 'evaluations'];
const EXPORT_RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 导出记录有效期 7 天

exports.main = async (event) => {
  const action = event && event.action;
  if (action === 'export.create') return createExport(event);
  if (action === 'export.list') return listExports(event);
  if (action === 'export.get') return getExport(event);
  return fail(400, 'UNKNOWN_ACTION');
};

/** 7-3-1：创建导出（生成 Excel -> 私有读云存储 -> 写 export_records -> 审计 -> 返回临时链接） */
async function createExport(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      export_type: { type: 'string', max: 32, required: true },
      start: { type: 'string', max: 10, default: '' },   // YYYY-MM-DD，可空
      end: { type: 'string', max: 10, default: '' },     // YYYY-MM-DD，可空
      status: { type: 'string', max: 32, default: '' },  // 工单状态过滤（可空）
      max_age: { type: 'number', min: 60, max: 86400, default: 1800 } // 临时链接有效期秒
    });
  } catch (e) {
    return fail(400, 'INVALID_PARAMS');
  }
  if (EXPORT_TYPES.indexOf(p.export_type) < 0) return fail(400, 'INVALID_EXPORT_TYPE');

  const ctx = await authGuard(event, { action: ACTIONS.EXPORT_CREATE });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db, openid, role, rowFilter } = ctx;

  // 限流：同一用户每分钟最多创建 5 次导出
  const rl = checkRateLimit('export:create', openid, 5);
  if (!rl.ok) return fail(429, 'EXPORT_TOO_FREQUENT');

  try {
    // 按类型聚合（行级过滤 + 时间范围）
    const bundle = await collectRows(p, ctx);
    if (!bundle.ok) return fail(bundle.code, bundle.msg);

    // 生成 Excel（SheetJS）
    const buffer = XLSX.write(bundle.workbook, { type: 'buffer', bookType: 'xlsx' });

    // 私有读云存储：exports/yyyyMM/ 随机文件名
    const now = new Date();
    const exportNo = genNo('EXP');
    const yyyyMM = now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0');
    const cloudPath = 'exports/' + yyyyMM + '/' + exportNo + '.xlsx';
    const upRes = await cloud.uploadFile({
      cloudPath,
      fileContent: buffer,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });

    const expireAt = new Date(now.getTime() + EXPORT_RECORD_TTL_MS);
    const addRes = await db.collection(COLLECTIONS.EXPORT_RECORDS).add({
      data: {
        export_no: exportNo,
        exporter_openid: openid,
        role,
        export_type: p.export_type,
        filters: { start: p.start, end: p.end, status: p.status },
        status: 'ready',
        file_id: upRes.fileID,
        file_name: exportNo + '.xlsx',
        rows: bundle.rows,
        expire_at: expireAt,
        created_at: now,
        updated_at: now
      }
    });

    // 审计
    await writeAudit(db, {
      actor_openid: openid, role,
      action: 'export.create',
      target_collection: COLLECTIONS.EXPORT_RECORDS,
      target_id: addRes._id,
      after: { export_no: exportNo, export_type: p.export_type, rows: bundle.rows, file_id: upRes.fileID }
    });

    // 临时链接（按需签发，不落库公开 URL）
    const tempUrl = await makeTempUrl(upRes.fileID, p.max_age);
    if (tempUrl.error) return fail(tempUrl.code, tempUrl.msg);

    return ok({
      export_id: addRes._id,
      export_no: exportNo,
      export_type: p.export_type,
      rows: bundle.rows,
      file_name: exportNo + '.xlsx',
      temp_file_url: tempUrl.url,
      expire_in: p.max_age
    });
  } catch (e) {
    console.error('[export] create error:', e);
    return fail(500, 'INTERNAL: export create failed');
  }
}

/** 7-3-2：导出记录列表（本人 / admin 全量） */
async function listExports(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      page: { type: 'number', min: 1, max: 10000, default: 1 },
      page_size: { type: 'number', min: 1, max: 50, default: 20 }
    });
  } catch (e) {
    return fail(400, 'INVALID_PARAMS');
  }
  const ctx = await authGuard(event, { action: ACTIONS.EXPORT_LIST });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db, openid, role } = ctx;
  try {
    const where = role === 'admin' ? {} : { exporter_openid: openid };
    const totalRes = await db.collection(COLLECTIONS.EXPORT_RECORDS).where(where).count();
    const res = await db.collection(COLLECTIONS.EXPORT_RECORDS)
      .where(where)
      .orderBy('created_at', 'desc')
      .skip((p.page - 1) * p.page_size)
      .limit(p.page_size)
      .get();
    const list = (res.data || []).map((r) => ({
      export_id: r._id,
      export_no: r.export_no,
      export_type: r.export_type,
      status: r.status,
      rows: r.rows,
      file_name: r.file_name,
      filters: r.filters || {},
      expire_at: r.expire_at || null,
      created_at: r.created_at || null
    }));
    return ok({ list, total: totalRes.total, page: p.page, page_size: p.page_size });
  } catch (e) {
    console.error('[export] list error:', e);
    return fail(500, 'INTERNAL: export list failed');
  }
}

/** 7-3-3：按导出记录换取临时链接（二次校验归属 + 记录有效期） */
async function getExport(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      export_id: { type: 'string', max: 64, required: true },
      max_age: { type: 'number', min: 60, max: 86400, default: 1800 }
    });
  } catch (e) {
    return fail(400, 'INVALID_PARAMS');
  }
  const ctx = await authGuard(event, { action: ACTIONS.EXPORT_LIST });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db, openid, role } = ctx;
  try {
    const res = await db.collection(COLLECTIONS.EXPORT_RECORDS).where({ _id: p.export_id }).limit(1).get();
    if (!res.data || !res.data.length) return fail(404, 'EXPORT_NOT_FOUND');
    const rec = res.data[0];

    // 二次校验：仅导出者本人（或 admin）可访问文件
    if (role !== 'admin' && rec.exporter_openid !== openid) {
      return fail(403, 'EXPORT_NOT_YOURS');
    }
    // 记录有效期：超过 expire_at 拒绝（需重新导出）
    const expireAt = rec.expire_at ? new Date(rec.expire_at).getTime() : 0;
    if (expireAt && expireAt < Date.now()) {
      return fail(410, 'EXPORT_EXPIRED');
    }

    const tempUrl = await makeTempUrl(rec.file_id, p.max_age);
    if (tempUrl.error) return fail(tempUrl.code, tempUrl.msg);

    return ok({
      export_id: rec._id,
      export_no: rec.export_no,
      export_type: rec.export_type,
      status: rec.status,
      file_name: rec.file_name,
      rows: rec.rows,
      temp_file_url: tempUrl.url,
      expire_in: p.max_age
    });
  } catch (e) {
    console.error('[export] get error:', e);
    return fail(500, 'INTERNAL: export get failed');
  }
}

/** 按导出场景聚合数据（行级过滤 + 二次校验 + 脱敏） */
async function collectRows(p, ctx) {
  const { db, role, openid, rowFilter } = ctx;
  const internal = role !== 'customer';

  if (p.export_type === 'workorders') {
    const list = await queryWorkOrders(db, rowFilter, p, internal);
    const rows = list.map((w) => {
      const base = {
        work_order_no: w.work_order_no,
        device_name: w.device_name || '',
        service_type: w.service_type || '',
        status: w.status,
        created_at: fmtDate(w.created_at),
        completed_at: fmtDate(w.completed_at)
      };
      if (internal) {
        base.parts_cost_fen = Number(w.parts_cost_fen) || 0;
        base.labor_fee_fen = Number(w.labor_fee_fen) || 0;
        base.transport_fee_fen = Number(w.transport_fee_fen) || 0;
        base.total_cost_fen = Number(w.total_cost_fen) || 0;
      }
      return base;
    });
    assertRowScope(list, ctx);
    return okBundle('工单清单', rows);
  }

  if (p.export_type === 'maintenance_report') {
    const list = await queryWorkOrders(db, rowFilter, p, internal, true);
    const rows = [];
    for (let i = 0; i < list.length; i += 1) {
      const w = list[i];
      const stepsRes = await db.collection(COLLECTIONS.WORK_STEPS)
        .where({ work_order_id: w._id }).limit(50).get();
      const accepted = !!(w.acceptance && w.acceptance.type === 'accepted');
      const row = {
        work_order_no: w.work_order_no,
        device_name: w.device_name || '',
        service_type: w.service_type || '',
        status: w.status,
        step_count: (stepsRes.data || []).length,
        accepted: accepted ? '是' : '否',
        rating: accepted && w.acceptance.rating ? w.acceptance.rating : '',
        completed_at: fmtDate(w.completed_at)
      };
      if (internal) {
        row.parts_cost_fen = Number(w.parts_cost_fen) || 0;
        row.labor_fee_fen = Number(w.labor_fee_fen) || 0;
        row.transport_fee_fen = Number(w.transport_fee_fen) || 0;
        row.total_cost_fen = Number(w.total_cost_fen) || 0;
      }
      rows.push(row);
    }
    assertRowScope(list, ctx);
    return okBundle('维修报表', rows);
  }

  if (p.export_type === 'inventory_flows') {
    if (!internal) return { ok: false, code: 403, msg: 'FORBIDDEN' }; // 库存流水仅内部角色
    const where = Object.assign({}, role === 'engineer' ? { operator: openid } : {});
    addTimeRange(where, p, 'created_at');
    const flows = await db.collection(COLLECTIONS.INVENTORY_FLOWS)
      .where(where).orderBy('created_at', 'desc').limit(2000).get();
    const rows = (flows.data || []).map((f) => ({
      flow_type: f.flow_type,
      quantity: Number(f.quantity) || 0,
      sn: f.sn || '',
      ref_type: f.ref_type || '',
      operator: maskOpenid(f.operator || ''),
      remark: f.remark || '',
      created_at: fmtDate(f.created_at)
    }));
    return okBundle('备件出入库流水', rows);
  }

  if (p.export_type === 'evaluations') {
    // 角色化过滤：客户=本人评价；工程师=被评本人；负责人/管理员=全量
    let evWhere = {};
    if (role === 'customer') evWhere.customer_openid = openid;
    if (role === 'engineer') evWhere.engineer_openid = openid;
    addTimeRange(evWhere, p, 'created_at');
    const evRes = await db.collection(COLLECTIONS.EVALUATIONS)
      .where(evWhere).orderBy('created_at', 'desc').limit(2000).get();
    const evs = evRes.data || [];

    // 工单号快照映射
    const woIds = evs.map((e) => e.work_order_id).filter(Boolean);
    const woNoById = {};
    if (woIds.length) {
      const woRes = await db.collection(COLLECTIONS.WORK_ORDERS)
        .where({ _id: _.in(woIds) }).field({ work_order_no: true }).limit(2000).get();
      (woRes.data || []).forEach((w) => { woNoById[w._id] = w.work_order_no; });
    }

    const rows = evs.map((e) => ({
      work_order_no: woNoById[e.work_order_id] || '',
      rating: Number(e.rating) || 0,
      tags: (e.tags || []).join('/'),
      content: e.content || '',
      reply: e.reply || '',
      created_at: fmtDate(e.created_at)
    }));

    // 回访计划 sheet（同角色范围）
    let visitWhere = {};
    if (role === 'customer') visitWhere.customer_openid = openid;
    if (role === 'engineer') visitWhere.owner_openid = openid; // 工程师不直接拥有回访，给空即可
    const visitRes = await db.collection(COLLECTIONS.VISIT_PLANS)
      .where(visitWhere).orderBy('visit_date', 'desc').limit(2000).get();
    const visitRows = (visitRes.data || []).map((v) => ({
      visit_date: fmtDate(v.visit_date),
      status: v.status,
      content: v.content || '',
      feedback: v.feedback || '',
      created_at: fmtDate(v.created_at)
    }));

    return okBundle('评价回访汇总', rows, [['评价明细', rows], ['回访计划', visitRows]]);
  }

  return { ok: false, code: 400, msg: 'INVALID_EXPORT_TYPE' };
}

async function queryWorkOrders(db, rowFilter, p, internal, onlyReportable) {
  const where = Object.assign({}, rowFilter);
  addTimeRange(where, p, 'created_at');
  if (p.status) where.status = p.status;
  if (onlyReportable) {
    where.status = _.in([WO_STATUS.ACCEPTED, WO_STATUS.CLOSED]);
  }
  const res = await db.collection(COLLECTIONS.WORK_ORDERS)
    .where(where).orderBy('created_at', 'desc').limit(2000).get();
  return res.data || [];
}

/** 二次校验：非管理角色逐行归属校验，越权行直接终止导出 */
function assertRowScope(list, ctx) {
  const { role, openid } = ctx;
  if (role === 'admin') return;
  const ok = list.every((w) => {
    if (role === 'customer') return w.customer_openid === openid;
    if (role === 'engineer') return w.engineer_openid === openid;
    if (role === 'owner') return w.owner_openid === openid;
    return false;
  });
  if (!ok) {
    const err = new Error('ROW_SCOPE_VIOLATION');
    err.code = 403;
    throw err;
  }
}

function addTimeRange(where, p, field) {
  if (p.start) where[field] = Object.assign({}, where[field] || {}, { gte: new Date(p.start + 'T00:00:00') });
  if (p.end) {
    const end = new Date(p.end + 'T23:59:59');
    if (where[field]) where[field].lte = end;
    else where[field] = { lte: end };
  }
}

function okBundle(title, rows, sheets) {
  const wb = XLSX.utils.book_new();
  const sheetRows = sheets || [[title, rows]];
  sheetRows.forEach(([name, data]) => {
    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, String(name).slice(0, 31));
  });
  return { ok: true, workbook: wb, rows: rows.length };
}

async function makeTempUrl(fileID, maxAge) {
  try {
    const res = await cloud.getTempFileURL({ fileList: [fileID], maxAge });
    const item = (res.fileList || [])[0];
    if (!item || item.status !== 0 || !item.tempFileURL) return { error: 500, code: 500, msg: 'TEMP_URL_FAILED' };
    return { url: item.tempFileURL };
  } catch (e) {
    console.error('[export] temp url error:', e);
    return { error: 500, code: 500, msg: 'TEMP_URL_FAILED' };
  }
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  const pad = (n) => String(n).padStart(2, '0');
  return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate()) + ' ' + pad(dt.getHours()) + ':' + pad(dt.getMinutes());
}

/** 7-4 脱敏：手机号 / 地址 / openid 掩码 */
function maskPhone(s) {
  const t = String(s || '');
  return t.length >= 7 ? t.slice(0, 3) + '****' + t.slice(-4) : (t ? '***' : '');
}
function maskAddress(s) {
  const t = String(s || '');
  return t.length > 6 ? t.slice(0, 3) + '****' + t.slice(-2) : (t ? '***' : '');
}
function maskOpenid(s) {
  const t = String(s || '');
  return t.length > 10 ? t.slice(0, 6) + '****' + t.slice(-4) : (t ? '***' : '');
}

module.exports = { main: exports.main, maskPhone, maskAddress, maskOpenid };

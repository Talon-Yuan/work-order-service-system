/**
 * spare-parts 云函数 — 备件主数据 / 批次 / 序列号 / 商城公开目录（阶段 4：任务 4-1 + 4-3）
 *
 * 动作码：
 *   store.list / sparepart.detail      商城公开只读（登录可读，隐藏成本价与内部字段）
 *   sparepart.create / update / alert  备件主数据 CRUD + 库存预警（管理端）
 *   batch.list / create / update       批次管理（管理端；新增批次自动写入库流水）
 *   sn.add / sn.update                 序列号维度 CRUD（管理端；变更写 inventory_flows 可追溯）
 *
 * 安全红线：目录写操作仅 owner/admin；公开读仅暴露商城字段；库存数量变更一律走事务流水。
 */
const { ok, fail } = require('./common/response');
const { ACTIONS, COLLECTIONS } = require('./common/constants');
const { cleanInput, inEnum } = require('./common/security');
const { authGuard } = require('./common/authGuard');
const { withTransaction, inInTx, writeFlowInTx, outInTx } = require('./common/inventoryOps');

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

/** 商城公开字段白名单（禁止把 cost_fen / _openid 等内部字段下发） */
const PUBLIC_FIELDS = [
  '_id', 'part_no', 'part_name', 'category', 'model', 'spec', 'unit',
  'price_fen', 'status', 'image_url', 'desc', 'warn_threshold', 'updated_at'
];

function pickPublic(doc) {
  const out = {};
  for (const k of PUBLIC_FIELDS) if (doc[k] !== undefined) out[k] = doc[k];
  return out;
}

function normalizeSnList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => {
    if (typeof x === 'string') return { sn: x, status: 'normal' };
    if (x && typeof x === 'object' && x.sn) return { sn: String(x.sn).slice(0, 64), status: x.status || 'normal' };
    return null;
  }).filter(Boolean);
}

exports.main = async (event) => {
  const action = event && event.action;
  switch (action) {
    case ACTIONS.STORE_LIST: return handleStoreList(event);
    case ACTIONS.SPARE_PART_DETAIL: return handlePartDetail(event);
    case ACTIONS.SPARE_PART_CREATE: return handlePartCreate(event);
    case ACTIONS.SPARE_PART_UPDATE: return handlePartUpdate(event);
    case ACTIONS.SPARE_PART_ALERT: return handleAlert(event);
    case ACTIONS.BATCH_LIST: return handleBatchList(event);
    case ACTIONS.BATCH_CREATE: return handleBatchCreate(event);
    case ACTIONS.BATCH_UPDATE: return handleBatchUpdate(event);
    case ACTIONS.SN_ADD: return handleSnAdd(event);
    case ACTIONS.SN_UPDATE: return handleSnUpdate(event);
    default:
      return fail(400, 'UNKNOWN_ACTION');
  }
};

/** 商城列表：spare_parts.status == 'on'，公开只读，分页 */
async function handleStoreList(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      category: { type: 'string', max: 32 },
      keyword: { type: 'string', max: 64 },
      page: { type: 'number' },
      page_size: { type: 'number' }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.STORE_LIST });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);

  const page = Math.max(1, Math.floor(p.page || 1));
  const pageSize = Math.min(20, Math.max(1, Math.floor(p.page_size || 10)));

  try {
    const cond = { status: 'on' };
    if (p.category) cond.category = p.category;
    const where = db.collection(COLLECTIONS.SPARE_PARTS).where(cond);
    if (p.keyword) {
      // 关键词：匹配名称/型号/规格（服务端拼接，前端不传查询运算符）
      const reg = db.RegExp({ regexp: escapeReg(p.keyword), options: 'i' });
      where.and(
        db.command.or([{ part_name: reg }, { model: reg }, { spec: reg }, { part_no: reg }])
      );
    }
    const [listRes, countRes] = await Promise.all([
      where.orderBy('updated_at', 'desc').skip((page - 1) * pageSize).limit(pageSize).get(),
      where.count()
    ]);
    return ok({
      list: (listRes.data || []).map(pickPublic),
      total: countRes.total,
      page,
      page_size: pageSize
    });
  } catch (e) {
    console.error('[spare-parts] store.list error:', e);
    return fail(500, 'INTERNAL: store list failed');
  }
}

function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 备件详情（商城公开字段） */
async function handlePartDetail(event) {
  let p;
  try { p = cleanInput(event || {}, { part_id: { type: 'string', max: 64, required: true } }); }
  catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.SPARE_PART_DETAIL });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);

  try {
    const res = await db.collection(COLLECTIONS.SPARE_PARTS).doc(p.part_id).get();
    if (!res.data) return fail(404, 'NOT_FOUND');
    return ok(pickPublic(res.data));
  } catch (e) {
    console.error('[spare-parts] detail error:', e);
    return fail(500, 'INTERNAL: detail failed');
  }
}

/** 备件主数据新增（管理端） */
async function handlePartCreate(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      part_no: { type: 'string', max: 64, required: true },
      part_name: { type: 'string', max: 128, required: true },
      category: { type: 'string', max: 32 },
      model: { type: 'string', max: 64 },
      spec: { type: 'string', max: 128 },
      unit: { type: 'string', max: 16 },
      price_fen: { type: 'number' },
      cost_fen: { type: 'number' },
      status: { type: 'string', max: 8 },
      image_url: { type: 'string', max: 512 },
      desc: { type: 'string', max: 1024 },
      warn_threshold: { type: 'number' }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.SPARE_PART_CREATE });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);

  if (!inEnum(p.status || 'on', ['on', 'off'])) return fail(400, 'INVALID_STATUS');

  try {
    // 编号唯一性：先查再写（管理端低频操作，骨架演示）
    const dup = await db.collection(COLLECTIONS.SPARE_PARTS).where({ part_no: p.part_no }).count();
    if (dup.total > 0) return fail(409, 'PART_NO_EXISTS');
    const now = Date.now();
    const doc = {
      part_no: p.part_no,
      part_name: p.part_name,
      category: p.category || '',
      model: p.model || '',
      spec: p.spec || '',
      unit: p.unit || '件',
      price_fen: Math.max(0, Math.floor(p.price_fen || 0)),
      cost_fen: Math.max(0, Math.floor(p.cost_fen || 0)),
      status: p.status || 'on',
      image_url: p.image_url || '',
      desc: p.desc || '',
      warn_threshold: Math.max(0, Math.floor(p.warn_threshold || 0)),
      created_at: now,
      updated_at: now,
      _openid: ctx.openid
    };
    const add = await db.collection(COLLECTIONS.SPARE_PARTS).add({ data: doc });
    return ok({ _id: add._id });
  } catch (e) {
    console.error('[spare-parts] create error:', e);
    return fail(500, 'INTERNAL: create failed');
  }
}

/** 备件主数据修改（管理端） */
async function handlePartUpdate(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      part_id: { type: 'string', max: 64, required: true },
      part_no: { type: 'string', max: 64 },
      part_name: { type: 'string', max: 128 },
      category: { type: 'string', max: 32 },
      model: { type: 'string', max: 64 },
      spec: { type: 'string', max: 128 },
      unit: { type: 'string', max: 16 },
      price_fen: { type: 'number' },
      cost_fen: { type: 'number' },
      status: { type: 'string', max: 8 },
      image_url: { type: 'string', max: 512 },
      desc: { type: 'string', max: 1024 },
      warn_threshold: { type: 'number' }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.SPARE_PART_UPDATE });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  if (p.status && !inEnum(p.status, ['on', 'off'])) return fail(400, 'INVALID_STATUS');

  try {
    const data = {};
    for (const k of ['part_no', 'part_name', 'category', 'model', 'spec', 'unit', 'status', 'image_url', 'desc']) {
      if (p[k] !== undefined) data[k] = p[k];
    }
    if (p.price_fen !== undefined) data.price_fen = Math.max(0, Math.floor(p.price_fen));
    if (p.cost_fen !== undefined) data.cost_fen = Math.max(0, Math.floor(p.cost_fen));
    if (p.warn_threshold !== undefined) data.warn_threshold = Math.max(0, Math.floor(p.warn_threshold));
    data.updated_at = Date.now();
    await db.collection(COLLECTIONS.SPARE_PARTS).doc(p.part_id).update({ data });
    return ok({ updated: true });
  } catch (e) {
    console.error('[spare-parts] update error:', e);
    return fail(500, 'INTERNAL: update failed');
  }
}

/**
 * 库存预警：对每个上架备件汇总可用库存，与 warn_threshold 比较。
 * 阈值来源：spare_parts.warn_threshold（备件级）优先；无备件级阈值时
 * 取该备件各批次 warn_threshold 之和（批次级覆盖，仅在有批次阈值时参与）。
 */
async function handleAlert(event) {
  const ctx = await authGuard(event, { action: ACTIONS.SPARE_PART_ALERT });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);

  try {
    const partsRes = await db.collection(COLLECTIONS.SPARE_PARTS).limit(1000).get();
    const parts = (partsRes.data || []).filter((d) => d.status === 'on');
    const batchesRes = await db.collection(COLLECTIONS.STOCK_BATCHES)
      .where({ status: 'active' }).limit(1000).get();
    const batches = batchesRes.data || [];

    const byPart = {};
    for (const b of batches) {
      if (!byPart[b.part_id]) byPart[b.part_id] = { available: 0, batchThreshold: 0, hasBatchThreshold: false };
      byPart[b.part_id].available += b.available || 0;
      if (b.warn_threshold) {
        byPart[b.part_id].batchThreshold += b.warn_threshold;
        byPart[b.part_id].hasBatchThreshold = true;
      }
    }

    const alerts = [];
    for (const part of parts) {
      const agg = byPart[part._id] || { available: 0, batchThreshold: 0, hasBatchThreshold: false };
      const threshold = (part.warn_threshold > 0)
        ? part.warn_threshold
        : (agg.hasBatchThreshold ? agg.batchThreshold : 0);
      if (threshold > 0 && agg.available <= threshold) {
        alerts.push({
          part_id: part._id,
          part_no: part.part_no,
          part_name: part.part_name,
          category: part.category,
          available: agg.available,
          threshold,
          level: agg.available === 0 ? 'empty' : (agg.available <= threshold * 0.5 ? 'critical' : 'low')
        });
      }
    }
    alerts.sort((a, b) => a.available - b.available);
    return ok({ list: alerts, total: alerts.length });
  } catch (e) {
    console.error('[spare-parts] alert error:', e);
    return fail(500, 'INTERNAL: alert failed');
  }
}

/** 批次列表（管理端；可带 part_id 过滤、分页） */
async function handleBatchList(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      part_id: { type: 'string', max: 64 },
      page: { type: 'number' },
      page_size: { type: 'number' }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.BATCH_LIST });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);

  const page = Math.max(1, Math.floor(p.page || 1));
  const pageSize = Math.min(50, Math.max(1, Math.floor(p.page_size || 10)));

  try {
    const cond = {};
    if (p.part_id) cond.part_id = p.part_id;
    const where = db.collection(COLLECTIONS.STOCK_BATCHES).where(cond);
    const [listRes, countRes] = await Promise.all([
      where.orderBy('created_at', 'desc').skip((page - 1) * pageSize).limit(pageSize).get(),
      where.count()
    ]);
    return ok({ list: listRes.data || [], total: countRes.total, page, page_size: pageSize });
  } catch (e) {
    console.error('[spare-parts] batch.list error:', e);
    return fail(500, 'INTERNAL: batch list failed');
  }
}

/** 批次新增（管理端）：事务内创建批次 + 入库流水 + 可选初始 SN */
async function handleBatchCreate(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      part_id: { type: 'string', max: 64, required: true },
      batch_no: { type: 'string', max: 64, required: true },
      quantity: { type: 'number', required: true },
      warehouse: { type: 'string', max: 32 },
      location: { type: 'string', max: 64 },
      expiry_date: { type: 'string', max: 32 },
      warn_threshold: { type: 'number' },
      sns: { type: 'array' }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.BATCH_CREATE });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);

  const quantity = Math.floor(p.quantity || 0);
  if (quantity <= 0) return fail(400, 'INVALID_QTY');
  const sns = normalizeSnList(p.sns || []);
  if (sns.length && sns.length !== quantity) return fail(400, 'SN_COUNT_MISMATCH');

  try {
    const result = await withTransaction(db, async (tx) => {
      const created = await inInTx(tx, p.part_id, quantity, {
        createBatch: true,
        batchNo: p.batch_no,
        warehouse: p.warehouse || '',
        location: p.location || '',
        expiryDate: p.expiry_date || null,
        warnThreshold: Math.max(0, Math.floor(p.warn_threshold || 0)),
        ref_type: 'batch',
        ref_id: 'batch:' + p.batch_no,
        remark: '批次入库:' + p.batch_no,
        operator: ctx.openid
      });
      // 初始 SN 写入批次
      if (sns.length) {
        await tx.collection(COLLECTIONS.STOCK_BATCHES).doc(created.batch_id).update({
          data: { sn_list: sns }
        });
      }
      return created;
    }, 3);

    return ok({ batch_id: result.batch_id });
  } catch (e) {
    console.error('[spare-parts] batch.create error:', e);
    if (e.message === 'BATCH_NOT_FOUND') return fail(404, 'BATCH_NOT_FOUND');
    return fail(500, 'INTERNAL: batch create failed');
  }
}

/** 批次修改（管理端）：仅描述字段；数量/SN 变更必须走 inventory / sn.* 流水接口 */
async function handleBatchUpdate(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      batch_id: { type: 'string', max: 64, required: true },
      warehouse: { type: 'string', max: 32 },
      location: { type: 'string', max: 64 },
      expiry_date: { type: 'string', max: 32 },
      warn_threshold: { type: 'number' },
      status: { type: 'string', max: 16 }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.BATCH_UPDATE });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  if (p.status && !inEnum(p.status, ['active', 'disabled'])) return fail(400, 'INVALID_STATUS');

  try {
    const data = {};
    for (const k of ['warehouse', 'location', 'expiry_date', 'status']) {
      if (p[k] !== undefined) data[k] = p[k];
    }
    if (p.warn_threshold !== undefined) data.warn_threshold = Math.max(0, Math.floor(p.warn_threshold));
    data.updated_at = Date.now();
    await db.collection(COLLECTIONS.STOCK_BATCHES).doc(p.batch_id).update({ data });
    return ok({ updated: true });
  } catch (e) {
    console.error('[spare-parts] batch.update error:', e);
    return fail(500, 'INTERNAL: batch update failed');
  }
}

/** 序列号添加（管理端）：SN 入库 → 数量+1、available+1、写 in 流水 */
async function handleSnAdd(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      batch_id: { type: 'string', max: 64, required: true },
      sn: { type: 'string', max: 64, required: true },
      remark: { type: 'string', max: 256 }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.SN_ADD });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);

  try {
    const result = await withTransaction(db, async (tx) => {
      const batch = await tx.collection(COLLECTIONS.STOCK_BATCHES).doc(p.batch_id).get();
      if (!batch.data) throw new Error('BATCH_NOT_FOUND');
      const snList = (batch.data.sn_list || []).map((x) =>
        typeof x === 'string' ? x : (x.sn || ''));
      if (snList.indexOf(p.sn) >= 0) throw new Error('SN_DUPLICATE');
      const created = await inInTx(tx, batch.data.part_id, 1, {
        batchId: p.batch_id,
        sn: p.sn,
        ref_type: 'sn',
        ref_id: 'sn:' + p.sn,
        remark: p.remark || '序列号入库',
        operator: ctx.openid
      });
      const newList = [...snList.map((s) => ({ sn: s, status: 'normal' })), { sn: p.sn, status: 'normal' }];
      await tx.collection(COLLECTIONS.STOCK_BATCHES).doc(p.batch_id).update({
        data: { sn_list: newList }
      });
      return created;
    }, 3);

    return ok({ batch_id: result.batch_id });
  } catch (e) {
    console.error('[spare-parts] sn.add error:', e);
    if (e.message === 'SN_DUPLICATE') return fail(409, 'SN_DUPLICATE');
    if (e.message === 'BATCH_NOT_FOUND') return fail(404, 'BATCH_NOT_FOUND');
    return fail(500, 'INTERNAL: sn add failed');
  }
}

/**
 * 序列号状态变更（管理端）：
 *   status: normal（在库）| reserved（预留）| used（已出库使用）| service_return（维修退回）
 *   变更 normal→used / used→normal 会同步调整库存并写 out/in 流水；
 *   其余标记类变更写 flow_type=sn_mark 流水（quantity=0）保证可追溯。
 */
async function handleSnUpdate(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      batch_id: { type: 'string', max: 64, required: true },
      sn: { type: 'string', max: 64, required: true },
      status: { type: 'string', max: 32, required: true },
      remark: { type: 'string', max: 256 }
    });
  } catch (e) { return fail(400, 'INVALID_PARAMS'); }

  const ctx = await authGuard(event, { action: ACTIONS.SN_UPDATE });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);

  const STATUS_SET = ['normal', 'reserved', 'used', 'service_return'];
  if (!inEnum(p.status, STATUS_SET)) return fail(400, 'INVALID_SN_STATUS');

  try {
    const result = await withTransaction(db, async (tx) => {
      const batch = await tx.collection(COLLECTIONS.STOCK_BATCHES).doc(p.batch_id).get();
      if (!batch.data) throw new Error('BATCH_NOT_FOUND');
      const raw = batch.data.sn_list || [];
      const idx = raw.findIndex((x) => (typeof x === 'string' ? x : x.sn) === p.sn);
      if (idx < 0) throw new Error('SN_NOT_FOUND');
      const cur = typeof raw[idx] === 'string'
        ? { sn: raw[idx], status: 'normal' }
        : { sn: raw[idx].sn, status: raw[idx].status || 'normal' };
      const newStatus = p.status;
      const partId = batch.data.part_id;

      if (cur.status !== newStatus) {
        if (cur.status === 'normal' && newStatus === 'used') {
          // 直接出库使用：available-1，写 out 流水
          await outInTx(tx, partId, 1, {
            alloc: [{ batch_id: p.batch_id, qty: 1 }],
            ref_type: 'sn',
            ref_id: 'sn:' + p.sn,
            sn: p.sn,
            remark: p.remark || 'SN 出库使用',
            operator: ctx.openid
          });
        } else if (cur.status === 'used' && newStatus === 'normal') {
          // 退回在库：available+1，写 in 流水
          await inInTx(tx, partId, 1, {
            batchId: p.batch_id,
            sn: p.sn,
            ref_type: 'sn',
            ref_id: 'sn:' + p.sn,
            remark: p.remark || 'SN 退回在库',
            operator: ctx.openid
          });
        } else {
          // 标记类变更：写 sn_mark 流水（数量不变，可追溯）
          await writeFlowInTx(tx, {
            part_id: partId,
            batch_id: p.batch_id,
            sn: p.sn,
            flow_type: 'sn_mark',
            quantity: 0,
            ref_type: 'sn',
            ref_id: 'sn:' + p.sn,
            remark: `SN 状态 ${cur.status} → ${newStatus}` + (p.remark ? '；' + p.remark : ''),
            operator: ctx.openid
          });
        }
      }

      const newList = raw.map((x, i) => {
        const s = typeof x === 'string' ? x : x.sn;
        const st = typeof x === 'string' ? 'normal' : (x.status || 'normal');
        return i === idx ? { sn: s, status: newStatus } : { sn: s, status: st };
      });
      await tx.collection(COLLECTIONS.STOCK_BATCHES).doc(p.batch_id).update({
        data: { sn_list: newList }
      });
      return { batch_id: p.batch_id, sn: p.sn, status: newStatus };
    }, 3);

    return ok(result);
  } catch (e) {
    console.error('[spare-parts] sn.update error:', e);
    if (e.message === 'SN_NOT_FOUND') return fail(404, 'SN_NOT_FOUND');
    if (e.message === 'BATCH_NOT_FOUND') return fail(404, 'BATCH_NOT_FOUND');
    return fail(500, 'INTERNAL: sn update failed');
  }
}

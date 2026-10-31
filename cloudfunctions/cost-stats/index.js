/**
 * cost-stats 云函数 — 阶段7-2：成本统计
 *  - 成本口径（项目书 7-2）：备件成本 parts_cost_fen、人工费 labor_fee_fen（工时 × 费率）、
 *    运输费 transport_fee_fen；总成本 total_cost_fen = 三者合计（工单结算时服务端写入）。
 *  - 统计对象：已发生成本（total_cost_fen > 0）的工单；时间口径按 completed_at（缺省 created_at）。
 *  - 行级过滤：负责人/管理员=组织/全量；工程师=本人派单；客户无成本统计权限（ROLE_CAPS 拒绝）。
 *  - 成本参数存 system_config（仅 admin 可写，写操作写审计日志）。
 */
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./common/response');
const { ACTIONS, COLLECTIONS } = require('./common/constants');
const { cleanInput } = require('./common/security');
const { authGuard } = require('./common/authGuard');
const { writeAudit } = require('./common/workflow');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const _ = cloud.database().command;

const CONFIG_KEYS = { LABOR: 'cost.labor_rate', TRANSPORT: 'cost.transport' };

exports.main = async (event) => {
  const action = event && event.action;
  if (action === 'cost.stats.read') return stats(event);
  if (action === 'cost.config.read') return configRead(event);
  if (action === 'cost.config.write') return configWrite(event);
  return fail(400, 'UNKNOWN_ACTION');
};

/** 7-2-1：成本统计（汇总 / 近N月趋势 / 构成 / TOP10） */
async function stats(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      months: { type: 'number', min: 1, max: 12, default: 6 } // 近 N 月（含本月）
    });
  } catch (e) {
    return fail(400, 'INVALID_PARAMS');
  }
  const ctx = await authGuard(event, { action: ACTIONS.COST_STATS_READ });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db, role, rowFilter } = ctx;
  const now = new Date();
  const rangeStart = new Date(now.getFullYear(), now.getMonth() - (p.months - 1), 1);

  try {
    const woRes = await db.collection(COLLECTIONS.WORK_ORDERS)
      .where(Object.assign({}, rowFilter, { total_cost_fen: _.gt(0), completed_at: _.gte(rangeStart) }))
      .field({
        work_order_no: true, device_name: true, service_type: true, status: true,
        parts_cost_fen: true, labor_fee_fen: true, transport_fee_fen: true,
        total_cost_fen: true, completed_at: true, created_at: true
      })
      .limit(2000).get();
    const list = woRes.data || [];

    let totalCostFen = 0, partsFen = 0, laborFen = 0, transportFen = 0, cnt = 0;
    const buckets = buildMonthBuckets(p.months, now);
    list.forEach((w) => {
      const parts = Number(w.parts_cost_fen) || 0;
      const labor = Number(w.labor_fee_fen) || 0;
      const transport = Number(w.transport_fee_fen) || 0;
      const total = Number(w.total_cost_fen) || 0;
      totalCostFen += total; partsFen += parts; laborFen += labor; transportFen += transport; cnt += 1;
      const mk = monthKey(w.completed_at || w.created_at);
      if (buckets.map[mk]) {
        buckets.map[mk].total_cost_fen += total;
        buckets.map[mk].parts_cost_fen += parts;
        buckets.map[mk].labor_fee_fen += labor;
        buckets.map[mk].transport_fee_fen += transport;
        buckets.map[mk].work_order_count += 1;
      }
    });

    const top = list
      .slice()
      .sort((a, b) => (Number(b.total_cost_fen) || 0) - (Number(a.total_cost_fen) || 0))
      .slice(0, 10)
      .map((w) => ({
        work_order_no: w.work_order_no,
        device_name: w.device_name || '',
        service_type: w.service_type || '',
        status: w.status,
        parts_cost_fen: Number(w.parts_cost_fen) || 0,
        labor_fee_fen: Number(w.labor_fee_fen) || 0,
        transport_fee_fen: Number(w.transport_fee_fen) || 0,
        total_cost_fen: Number(w.total_cost_fen) || 0,
        completed_at: w.completed_at || w.created_at || null
      }));

    return ok({
      summary: {
        total_cost_fen: totalCostFen,
        parts_cost_fen: partsFen,
        labor_fee_fen: laborFen,
        transport_fee_fen: transportFen,
        work_order_count: cnt,
        avg_cost_fen: cnt ? Math.round(totalCostFen / cnt) : 0
      },
      trend: buckets.arr,
      composition: [
        { name: 'parts', fen: partsFen },
        { name: 'labor', fen: laborFen },
        { name: 'transport', fen: transportFen }
      ],
      top,
      month_scope: { start: rangeStart.toISOString(), end: now.toISOString() },
      role,
      generated_at: now.toISOString()
    });
  } catch (e) {
    console.error('[cost-stats] stats error:', e);
    return fail(500, 'INTERNAL: cost stats failed');
  }
}

/** 7-2-2：读取成本参数（owner/admin） */
async function configRead(event) {
  const ctx = await authGuard(event, { action: ACTIONS.COST_CONFIG_READ });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db } = ctx;
  try {
    const res = await db.collection(COLLECTIONS.SYSTEM_CONFIG)
      .where({ _id: _.in([CONFIG_KEYS.LABOR, CONFIG_KEYS.TRANSPORT]) })
      .limit(10).get();
    const byKey = {};
    (res.data || []).forEach((c) => { byKey[c._id] = c.value || {}; });
    return ok({
      labor_rate: byKey[CONFIG_KEYS.LABOR] || { per_hour_fen: 0, currency: 'CNY' },
      transport: byKey[CONFIG_KEYS.TRANSPORT] || { base_fen: 0, per_km_fen: 0, currency: 'CNY' }
    });
  } catch (e) {
    console.error('[cost-stats] config read error:', e);
    return fail(500, 'INTERNAL: cost config read failed');
  }
}

/** 7-2-3：写入成本参数（仅 admin，带审计） */
async function configWrite(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      labor_hour_rate_fen: { type: 'number', min: 0, max: 100000000, required: true },
      transport_base_fen: { type: 'number', min: 0, max: 100000000, required: true },
      transport_per_km_fen: { type: 'number', min: 0, max: 100000000, required: true }
    });
  } catch (e) {
    return fail(400, 'INVALID_PARAMS');
  }
  const ctx = await authGuard(event, { action: ACTIONS.COST_CONFIG_WRITE });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db, openid, role } = ctx;
  const now = new Date();
  try {
    await upsertConfig(db, CONFIG_KEYS.LABOR, { per_hour_fen: p.labor_hour_rate_fen, currency: 'CNY' }, openid, now);
    await upsertConfig(db, CONFIG_KEYS.TRANSPORT, { base_fen: p.transport_base_fen, per_km_fen: p.transport_per_km_fen, currency: 'CNY' }, openid, now);
    await writeAudit(db, {
      actor_openid: openid, role,
      action: 'cost.config.write',
      target_collection: COLLECTIONS.SYSTEM_CONFIG,
      target_id: CONFIG_KEYS.LABOR + ',' + CONFIG_KEYS.TRANSPORT,
      after: {
        labor_hour_rate_fen: p.labor_hour_rate_fen,
        transport_base_fen: p.transport_base_fen,
        transport_per_km_fen: p.transport_per_km_fen
      }
    });
    return ok({ updated_at: now.toISOString() });
  } catch (e) {
    console.error('[cost-stats] config write error:', e);
    return fail(500, 'INTERNAL: cost config write failed');
  }
}

/** system_config 按 _id upsert（存在则更新，不存在则新建） */
async function upsertConfig(db, key, value, openid, now) {
  const res = await db.collection(COLLECTIONS.SYSTEM_CONFIG).where({ _id: key }).limit(1).get();
  const doc = {
    type: 'cost',
    value,
    label: key === CONFIG_KEYS.LABOR ? '工时费率' : '运输单价',
    updater_openid: openid,
    updated_at: now,
    created_at: now
  };
  if (res.data && res.data.length) {
    await db.collection(COLLECTIONS.SYSTEM_CONFIG).doc(res.data[0]._id).update({ data: doc });
  } else {
    await db.collection(COLLECTIONS.SYSTEM_CONFIG).add({ data: Object.assign({ _id: key }, doc) });
  }
}

function monthKey(d) {
  const dt = d ? new Date(d) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return dt.getFullYear() + '-' + pad(dt.getMonth() + 1);
}

function buildMonthBuckets(months, now) {
  const arr = [];
  const map = {};
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = monthKey(d);
    const item = {
      month: key,
      total_cost_fen: 0,
      parts_cost_fen: 0,
      labor_fee_fen: 0,
      transport_fee_fen: 0,
      work_order_count: 0
    };
    arr.push(item);
    map[key] = item;
  }
  return { arr, map };
}

module.exports = { main: exports.main };

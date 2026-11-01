/**
 * dashboard 云函数 — 阶段7-1：数据看板（Web 管理端 / 小程序共用）
 *  - 看板聚合全部在云函数内完成（KPI + 按天趋势），禁止前端直连数据库聚合；
 *  - 行级过滤复用 authGuard.buildRowFilter（客户=本人、工程师=派单、负责人=组织/本人、管理员=全量）；
 *  - 数据脱敏与最小返回（7-4）：客户视角不返回成本与库存预警等内部指标；
 *  - 成本/库存聚合仅内部角色（owner / engineer / admin）返回，客户接口零成本字段。
 */
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./common/response');
const { ACTIONS, COLLECTIONS, WO_STATUS, APPOINTMENT_STATUS } = require('./common/constants');
const { cleanInput } = require('./common/security');
const { authGuard } = require('./common/authGuard');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const _ = cloud.database().command;

exports.main = async (event) => {
  const action = event && event.action;
  if (action === 'dashboard.overview') return overview(event);
  return fail(400, 'UNKNOWN_ACTION');
};

/** 7-1-1：看板概览（KPI + 趋势） */
async function overview(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      days: { type: 'number', min: 1, max: 90, default: 30 } // 趋势窗口（天）
    });
  } catch (e) {
    return fail(400, 'INVALID_PARAMS');
  }
  const ctx = await authGuard(event, { action: ACTIONS.DASHBOARD_OVERVIEW });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db, role, rowFilter } = ctx;
  const internal = role !== 'customer';

  const now = new Date();
  const start = new Date(now.getTime() - p.days * 86400 * 1000);

  try {
    // —— 工单 KPI（按状态分组，一次拉取内存聚合） ——
    const woRes = await db.collection(COLLECTIONS.WORK_ORDERS)
      .where(Object.assign({}, rowFilter, { created_at: _.gte(start) }))
      .field({ status: true, total_cost_fen: true, device_id: true })
      .limit(1000).get();
    const woList = woRes.data || [];
    const woByStatus = {};
    Object.keys(WO_STATUS).forEach((k) => { woByStatus[WO_STATUS[k]] = 0; });
    let woTotal = 0, costFen = 0, costWo = 0;
    woList.forEach((w) => {
      woByStatus[w.status] = (woByStatus[w.status] || 0) + 1;
      woTotal += 1;
      if (w.total_cost_fen) { costFen += w.total_cost_fen; costWo += 1; }
    });

    // —— 预约 KPI（近 N 天 + 待审批） ——
    const apptRes = await db.collection(COLLECTIONS.APPOINTMENTS)
      .where(Object.assign({}, rowFilter, { created_at: _.gte(start) }))
      .field({ status: true })
      .limit(1000).get();
    const apptList = apptRes.data || [];
    let appointmentsPending = 0;
    apptList.forEach((a) => { if (a.status === APPOINTMENT_STATUS.PENDING) appointmentsPending += 1; });

    // —— 低库存预警（仅内部角色）：备件阈值 vs 批次可用数聚合 ——
    let lowStockCount = 0;
    if (internal) {
      const partsRes = await db.collection(COLLECTIONS.SPARE_PARTS)
        .where({ status: 'on' })
        .field({ part_no: true, part_name: true, warn_threshold: true })
        .limit(500).get();
      const parts = partsRes.data || [];
      const batchRes = await db.collection(COLLECTIONS.STOCK_BATCHES)
        .where({ status: 'active' })
        .field({ part_id: true, quantity: true, reserved: true, warn_threshold: true })
        .limit(1000).get();
      const availByPart = {};
      (batchRes.data || []).forEach((b) => {
        const avail = (Number(b.quantity) || 0) - (Number(b.reserved) || 0);
        availByPart[b.part_id] = (availByPart[b.part_id] || 0) + avail;
      });
      lowStockCount = parts.reduce((acc, pt) => {
        const avail = availByPart[pt._id] || 0;
        const th = Number(pt.warn_threshold) || 0;
        if (th > 0 && avail <= th) acc += 1;
        return acc;
      }, 0);
    }

    // —— 趋势（按天分组：工单数 / 预约数 / 成本，成本仅内部角色） ——
    const trend = buildTrend(p.days, start);
    woList.forEach((w) => {
      const k = dayKey(w.created_at);
      if (trend.map[k]) {
        trend.map[k].work_orders += 1;
        if (internal && w.total_cost_fen) trend.map[k].cost_fen += w.total_cost_fen;
      }
    });
    apptList.forEach((a) => {
      const k = dayKey(a.created_at);
      if (trend.map[k]) trend.map[k].appointments += 1;
    });

    const kpi = {
      work_orders: { total: woTotal, by_status: woByStatus },
      appointments: { total: apptList.length, pending: appointmentsPending },
      low_stock: internal ? lowStockCount : null
    };
    if (internal) {
      kpi.cost = {
        total_fen: costFen,
        work_order_count: costWo,
        avg_fen: costWo ? Math.round(costFen / costWo) : 0
      };
    }

    // 首页统计补充：进行中工单（施工中+待验收）与报修设备数（窗口内去重，忽略空 device_id）
    const deviceSet = new Set();
    woList.forEach((w) => { if (w.device_id) deviceSet.add(w.device_id); });
    const wos = (woByStatus[WO_STATUS.PROCESSING] || 0) + (woByStatus[WO_STATUS.PENDING_ACCEPTANCE] || 0);
    const devices = deviceSet.size;

    return ok({
      kpi,
      trend: trend.arr,
      role,
      generated_at: now.toISOString(),
      devices,
      wos
    });
  } catch (e) {
    console.error('[dashboard] overview error:', e);
    return fail(500, 'INTERNAL: dashboard overview failed');
  }
}

function dayKey(d) {
  const dt = d ? new Date(d) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
}

/** 构建 N 天空桶 */
function buildTrend(days, start) {
  const arr = [];
  const map = {};
  for (let i = 0; i < days; i += 1) {
    const d = new Date(start.getTime() + i * 86400 * 1000);
    const key = dayKey(d);
    const item = { date: key, work_orders: 0, appointments: 0, cost_fen: 0 };
    arr.push(item);
    map[key] = item;
  }
  return { arr, map };
}

module.exports = { main: exports.main };

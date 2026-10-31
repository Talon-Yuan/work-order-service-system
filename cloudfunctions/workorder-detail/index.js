/**
 * workorder-detail 云函数 — 工单详情（阶段 2：三档可见性落地演示）
 * 防水平越权：查询条件 = rowFilter + _id，查不到即 404，绝不返回他人工单；
 * 时间字段以北京时间（GMT+8）存储，前端 timezone.js 按用户所在地换算展示。
 */
const { ok, fail } = require('./common/response');
const { ACTIONS, COLLECTIONS } = require('./common/constants');
const { cleanInput } = require('./common/security');
const { authGuard } = require('./common/authGuard');

exports.main = async (event) => {
  let p;
  try {
    p = cleanInput(event || {}, { id: { type: 'string', max: 64, required: true } });
  } catch (e) {
    return fail(400, 'INVALID_PARAMS');
  }

  const ctx = await authGuard(event, { action: ACTIONS.WO_DETAIL });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);

  const { db, openid, role, rowFilter } = ctx;

  try {
    // 行级过滤 + 指定 id：A 用户抓包改 id 只能查到 B 用户过滤条件内的记录，命中率 0 → 404
    const cond = Object.assign({}, rowFilter, { _id: p.id });
    const res = await db.collection(COLLECTIONS.WORK_ORDERS).where(cond).limit(1).get();
    if (!res.data.length) return fail(404, 'NOT_FOUND');

    const d = res.data[0];
    // 步骤进度聚合（work_steps）
    const stepsRes = await db.collection(COLLECTIONS.WORK_STEPS)
      .where({ work_order_id: d._id }).orderBy('step_no', 'asc').limit(50).get();

    return ok({
      work_order: {
        _id: d._id,
        work_order_no: d.work_order_no,
        service_type: d.service_type,
        status: d.status,
        summary: d.summary || '',
        labor_fee_fen: d.labor_fee_fen || 0,
        transport_fee_fen: d.transport_fee_fen || 0,
        parts_cost_fen: d.parts_cost_fen || 0,
        total_cost_fen: d.total_cost_fen || 0,
        completed_at: d.completed_at || null,
        created_at: d.created_at,
        updated_at: d.updated_at
      },
      steps: stepsRes.data.map((s) => ({
        step_no: s.step_no, name: s.name, status: s.status,
        started_at: s.started_at || null, finished_at: s.finished_at || null,
        remark: s.remark || ''
      })),
      role,
      scope: Object.keys(rowFilter).length ? Object.keys(rowFilter).join(',') : 'all'
    });
  } catch (e) {
    console.error('[workorder-detail] error:', e);
    return fail(500, 'INTERNAL: detail failed');
  }
};

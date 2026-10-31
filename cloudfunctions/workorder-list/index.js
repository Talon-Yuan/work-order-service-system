/**
 * workorder-list 云函数 — 工单列表（阶段 2：三档可见性落地演示）
 * 行级过滤由 authGuard.buildRowFilter 按角色注入：
 *   - customer：WHERE customer_openid == 本人（只看自己的工单进度）
 *   - engineer：WHERE engineer_openid == 本人（只看派给自己的工单）
 *   - owner   ：WHERE org == 本人组织（或 owner_openid == 本人兜底）→ 全量（组织范围）
 *   - admin   ：WHERE {}（全量）
 * 安全红线：查询条件服务端拼接，禁止前端传 where/openid 覆盖；分页强制 LIMIT。
 */
const { ok, fail } = require('./common/response');
const { ACTIONS, COLLECTIONS } = require('./common/constants');
const { cleanInput } = require('./common/security');
const { authGuard } = require('./common/authGuard');

exports.main = async (event) => {
  let p;
  try {
    p = cleanInput(event || {}, {
      status: { type: 'string', max: 32 },
      page: { type: 'number' },
      page_size: { type: 'number' }
    });
  } catch (e) {
    return fail(400, 'INVALID_PARAMS');
  }

  const ctx = await authGuard(event, { action: ACTIONS.WO_LIST });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);

  const { db, openid, role, rowFilter, session } = ctx;
  const page = Math.max(1, Math.floor(p.page || 1));
  const pageSize = Math.min(20, Math.max(1, Math.floor(p.page_size || 10)));

  try {
    // 三档可见：rowFilter 与业务筛选条件合并（服务端强制，前端不可覆盖）
    const cond = Object.assign({}, rowFilter);
    if (p.status) cond.status = p.status;

    const where = db.collection(COLLECTIONS.WORK_ORDERS).where(cond);
    const [listRes, countRes] = await Promise.all([
      where.orderBy('created_at', 'desc').skip((page - 1) * pageSize).limit(pageSize).get(),
      where.count()
    ]);

    const list = listRes.data.map((d) => ({
      _id: d._id,
      work_order_no: d.work_order_no,
      service_type: d.service_type,
      status: d.status,
      appointment_id: d.appointment_id,
      device_id: d.device_id,
      created_at: d.created_at,
      summary: (d.summary || '').slice(0, 60)
    }));

    return ok({
      list,
      total: countRes.total,
      page,
      page_size: pageSize,
      role,
      scope: Object.keys(rowFilter).length ? Object.keys(rowFilter).join(',') : 'all' // 演示：命中行级过滤维度
    });
  } catch (e) {
    console.error('[workorder-list] error:', e);
    return fail(500, 'INTERNAL: list failed');
  }
};

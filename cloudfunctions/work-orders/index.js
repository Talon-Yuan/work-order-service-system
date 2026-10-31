/**
 * work-orders 云函数 — 任务 5-1：工单创建与施工进度
 *  - wo.create    ：预约→工单创建（owner/admin；校验预约已批准；初始化标准步骤；审计+通知客户）
 *  - wo.progress  ：施工进度追加（工程师；work_steps 步骤 + 分类照片数组 photos；审计）
 * 安全要点：
 *  - 进度追加必须走云函数（带 audit_logs），前端零直连写库；
 *  - 所有写入的 openid 来自服务端身份（authGuard），客户端传参不可信；
 *  - 状态相关流转全部走 statemachine 云函数（wo.transition），本函数不直接改状态。
 */
const { ok, fail } = require('./common/response');
const { ACTIONS, COLLECTIONS, WO_STATUS } = require('./common/constants');
const { cleanInput } = require('./common/security');
const { authGuard } = require('./common/authGuard');
const { writeAudit, sendNotification, genNo } = require('./common/workflow');

/** 标准施工步骤模板（签到/检测/报价/施工/验收） */
const DEFAULT_STEPS = [
  { name: 'sign',   label: '签到', code: 'SIGN' },
  { name: 'detect', label: '检测', code: 'DETECT' },
  { name: 'quote',  label: '报价', code: 'QUOTE' },
  { name: 'construct', label: '施工', code: 'CONSTRUCT' },
  { name: 'accept', label: '验收', code: 'ACCEPT' }
];

exports.main = async (event) => {
  const action = event && event.action;

  if (action === 'wo.create') return createWorkOrder(event);
  if (action === 'wo.progress') return appendProgress(event);
  if (action === 'wo.steps') return listSteps(event);

  return fail(400, 'UNKNOWN_ACTION');
};

/** 5-1a：预约→工单创建 */
async function createWorkOrder(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      appointment_id: { type: 'string', max: 64, required: true },
      service_type: { type: 'string', max: 40, required: true },
      device_name: { type: 'string', max: 60, default: '' },
      engineer_openid: { type: 'string', max: 64, default: '' },
      remark: { type: 'string', max: 300, default: '' }
    });
  } catch (e) {
    return fail(400, 'INVALID_PARAMS');
  }

  const ctx = await authGuard(event, { action: ACTIONS.WO_CREATE });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db, openid, role } = ctx;

  try {
    // 预约必须存在且已批准
    const apptRes = await db.collection(COLLECTIONS.APPOINTMENTS).where({ _id: p.appointment_id }).limit(1).get();
    if (!apptRes.data.length) return fail(404, 'APPOINTMENT_NOT_FOUND');
    const appt = apptRes.data[0];
    if (appt.status !== 'approved') return fail(409, 'APPOINTMENT_NOT_APPROVED');

    // 防重复创建：同一预约只允许一个有效工单（pending/processing/pending_acceptance）
    const existRes = await db.collection(COLLECTIONS.WORK_ORDERS)
      .where({ appointment_id: p.appointment_id })
      .limit(1).get();
    if (existRes.data.length) return fail(409, 'WORK_ORDER_EXISTS');

    const now = new Date();
    const workOrderNo = genNo('WO');
    const doc = {
      work_order_no: workOrderNo,
      appointment_id: p.appointment_id,
      customer_openid: appt.customer_openid || appt._openid || '',  // 客户身份服务端写入
      owner_openid: openid,                                          // 创建人=负责人
      engineer_openid: p.engineer_openid || '',
      device_id: appt.device_id || '',
      device_name: p.device_name || appt.device_name || '',
      service_type: p.service_type,
      status: WO_STATUS.PENDING,
      summary: p.remark || '',
      labor_fee_fen: 0, transport_fee_fen: 0, parts_cost_fen: 0, total_cost_fen: 0,
      acceptance: null,          // 阶段5：验收信息（accept 云函数写入）
      need_evaluation: false,    // 阶段5：验收后评价邀请标记（statemachine 写入）
      report_id: '',             // 阶段5：关联服务报告（report 云函数写入）
      completed_at: null,
      created_at: now,
      updated_at: now
    };
    const addRes = await db.collection(COLLECTIONS.WORK_ORDERS).add({ data: doc });
    const woId = addRes._id;

    // 初始化标准施工步骤（work_steps）
    const stepTasks = DEFAULT_STEPS.map((s, idx) =>
      db.collection(COLLECTIONS.WORK_STEPS).add({
        data: {
          work_order_id: woId,
          step_no: idx + 1,
          name: s.name,
          label: s.label,
          status: 'pending',
          operator_openid: '',
          photos: [],            // 阶段5：分类照片数组（fileID 列表，由 upload 云函数写入）
          started_at: null,
          finished_at: null,
          remark: '',
          created_at: now,
          updated_at: now
        }
      })
    );
    await Promise.all(stepTasks);

    // 审计（关键创建操作）
    await writeAudit(db, {
      actor_openid: openid, role,
      action: 'create', target_collection: COLLECTIONS.WORK_ORDERS, target_id: woId,
      after: { work_order_no: workOrderNo, appointment_id: p.appointment_id, status: WO_STATUS.PENDING }
    });

    // 通知客户：工单已创建
    await sendNotification(db, {
      receiver_openid: doc.customer_openid,
      type: 'work_order', title: '工单已创建', content: '您的服务工单 ' + workOrderNo + ' 已创建，进入待处理状态。',
      ref_type: 'work_order', ref_id: woId
    });

    return ok({ _id: woId, work_order_no: workOrderNo, status: WO_STATUS.PENDING });
  } catch (e) {
    console.error('[work-orders] create error:', e);
    return fail(500, 'INTERNAL: create work order failed');
  }
}

/** 5-1b：施工进度追加（工程师，带审计，前端不可直写） */
async function appendProgress(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      work_order_id: { type: 'string', max: 64, required: true },
      step_no: { type: 'number', min: 1, max: 50, required: true },
      name: { type: 'string', max: 40, required: true },     // 步骤名 sign/detect/quote/construct/accept
      status: { type: 'string', max: 20, default: 'done' }, // pending/doing/done/skipped
      remark: { type: 'string', max: 500, default: '' },
      photos: { type: 'array', default: [] },                // 分类照片数组（fileID 列表，经 upload 云函数产生）
      cost_fen: { type: 'number', default: 0 }               // 可选：报价/施工步骤的成本增量（分）
    });
  } catch (e) {
    return fail(400, 'INVALID_PARAMS');
  }
  if (p.photos.length > 20) return fail(400, 'PHOTOS_TOO_MANY');

  const ctx = await authGuard(event, { action: ACTIONS.WO_PROGRESS });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db, openid, role } = ctx;

  try {
    // 行级过滤读取工单：工程师只能操作本人负责/参与的工单
    const woRes = await db.collection(COLLECTIONS.WORK_ORDERS)
      .where(Object.assign({}, ctx.rowFilter, { _id: p.work_order_id }))
      .limit(1).get();
    if (!woRes.data.length) return fail(404, 'WORK_ORDER_NOT_FOUND');
    const wo = woRes.data[0];
    // 仅施工中/待验收/驳回重施工允许追加进度；终态禁止
    if (![WO_STATUS.PROCESSING, WO_STATUS.PENDING_ACCEPTANCE, WO_STATUS.REJECTED].includes(wo.status)) {
      return fail(409, 'WO_STATUS_FORBIDS_PROGRESS');
    }

    // 校验步骤存在且未越界
    const stepRes = await db.collection(COLLECTIONS.WORK_STEPS)
      .where({ work_order_id: p.work_order_id, step_no: p.step_no }).limit(1).get();
    if (!stepRes.data.length) return fail(404, 'STEP_NOT_FOUND');
    const step = stepRes.data[0];
    // 已 done 的步骤允许补充照片/备注（追加），不允许改步骤名与顺序
    const now = new Date();
    const photoArray = (step.photos || []).concat(
      Array.isArray(p.photos) ? p.photos.filter((x) => typeof x === 'string' && x.length <= 200) : []
    );
    if (photoArray.length > 50) return fail(400, 'STEP_PHOTOS_TOO_MANY');

    await db.collection(COLLECTIONS.WORK_STEPS).doc(step._id).update({
      data: {
        name: p.name,
        status: p.status,
        remark: p.remark,
        photos: photoArray,
        operator_openid: openid,                     // 服务端身份，禁客户端伪造
        started_at: p.status === 'doing' ? (step.started_at || now) : step.started_at,
        finished_at: p.status === 'done' || p.status === 'skipped' ? now : null,
        updated_at: now
      }
    });

    // 若带成本增量，汇总工单成本（报价/施工步骤）
    if (p.cost_fen > 0) {
      const inc = Number(p.cost_fen) || 0;
      await db.collection(COLLECTIONS.WORK_ORDERS).doc(wo._id).update({
        data: {
          parts_cost_fen: (wo.parts_cost_fen || 0) + inc,
          total_cost_fen: (wo.total_cost_fen || 0) + inc,
          updated_at: now
        }
      });
    }

    // 审计（进度追加）
    await writeAudit(db, {
      actor_openid: openid, role,
      action: 'progress', target_collection: COLLECTIONS.WORK_STEPS, target_id: step._id,
      before: { work_order_id: wo._id, step_no: p.step_no, status: step.status, photos: (step.photos || []).length },
      after: { work_order_id: wo._id, step_no: p.step_no, status: p.status, photos: photoArray.length }
    });

    return ok({ work_order_id: wo._id, step_no: p.step_no, photos: photoArray.length, updated_at: now });
  } catch (e) {
    console.error('[work-orders] progress error:', e);
    return fail(500, 'INTERNAL: append progress failed');
  }
}

/** 5-1c：工单进度查询（步骤聚合，行级过滤） */
async function listSteps(event) {
  let p;
  try {
    p = cleanInput(event || {}, { work_order_id: { type: 'string', max: 64, required: true } });
  } catch (e) {
    return fail(400, 'INVALID_PARAMS');
  }
  const ctx = await authGuard(event, { action: ACTIONS.WO_DETAIL });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db } = ctx;
  try {
    const woRes = await db.collection(COLLECTIONS.WORK_ORDERS)
      .where(Object.assign({}, ctx.rowFilter, { _id: p.work_order_id })).limit(1).get();
    if (!woRes.data.length) return fail(404, 'WORK_ORDER_NOT_FOUND');
    const stepsRes = await db.collection(COLLECTIONS.WORK_STEPS)
      .where({ work_order_id: p.work_order_id }).orderBy('step_no', 'asc').limit(50).get();
    return ok({
      work_order_id: p.work_order_id,
      steps: stepsRes.data.map((s) => ({
        step_no: s.step_no, name: s.name, label: s.label, status: s.status,
        photos: s.photos || [], remark: s.remark || '',
        operator_openid: s.operator_openid || '',
        started_at: s.started_at || null, finished_at: s.finished_at || null
      }))
    });
  } catch (e) {
    console.error('[work-orders] steps error:', e);
    return fail(500, 'INTERNAL: list steps failed');
  }
}

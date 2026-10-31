/**
 * cron 云函数 — 阶段 6-4：定时触发器（保养提醒 / 库存预警 / 支付对账 / 报告清理）
 *
 * 调度：config.json triggers 配置 4 个定时触发器；云开发定时触发 event 带 TriggerName，
 *       本函数识别触发器来源后放行；手动触发需 admin（cron.run），供验收与补跑。
 *
 * 安全：
 *  - 定时任务只写站内通知/审计/标记，不做破坏性删除（报告清理为归档标记）；
 *  - 支付对账保守处理：仅标记可疑并通知，不自动取消订单/退款；
 *  - 订阅消息发送统一走 subscribe 云函数（内部密钥），未配置时跳过并记 audit。
 */
const cloud = require('wx-server-sdk');
const { ok, fail } = require('./common/response');
const { ACTIONS, COLLECTIONS, CRON_JOBS, SUB_TEMPLATE_TYPES } = require('./common/constants');
const { authGuard } = require('./common/authGuard');
const { writeAudit, sendNotification } = require('./common/workflow');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

/** 保留期（天），默认 180 */
const RETENTION_DAYS = Number(process.env.REPORT_RETENTION_DAYS) || 180;

exports.main = async (event) => {
  // 云开发定时触发器 event：{ TriggerName, Time, Type }，无用户身份
  const isTimer = !!(event && event.TriggerName);
  if (!isTimer) {
    const ctx = await authGuard(event, { action: ACTIONS.CRON_RUN });
    if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  }
  const job = event && (event.job || event.JobName || event.TriggerName);
  if (!job) return fail(400, 'JOB_REQUIRED');

  try {
    if (job === CRON_JOBS.MAINTENANCE_REMINDER) return await maintenanceReminder();
    if (job === CRON_JOBS.STOCK_ALERT) return await stockAlert();
    if (job === CRON_JOBS.PAY_RECONCILE) return await payReconcile();
    if (job === CRON_JOBS.REPORT_CLEANUP) return await reportCleanup();
    return fail(400, 'UNKNOWN_JOB');
  } catch (e) {
    console.error('[cron] job error:', e.message);
    return fail(500, 'INTERNAL: cron job failed');
  }
};

/** 6-4a：保养提醒 —— device_profiles.next_maintenance_date 在未来 7 天内 */
async function maintenanceReminder() {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
  const res = await db.collection(COLLECTIONS.DEVICE_PROFILES)
    .where({
      status: 'active',
      next_maintenance_date: _.gte(now).and(_.lte(windowEnd))
    })
    .limit(100)
    .get();

  let sent = 0;
  for (const dev of res.data || []) {
    // 防重复：仅当上次提醒目标日期 != 当前目标日期时发送
    if (dev.reminded_maintenance_date && dev.reminded_maintenance_date === dev.next_maintenance_date) continue;
    if (dev.customer_openid) {
      await sendNotification(db, {
        receiver_openid: dev.customer_openid, type: 'maintenance',
        title: '设备保养提醒',
        content: '设备 ' + (dev.device_name || dev.serial_no || '') + ' 保养日期为 ' + dev.next_maintenance_date + '，请预约保养服务。',
        ref_type: 'device_profile', ref_id: dev._id
      });
      sent += 1;
    }
    await db.collection(COLLECTIONS.DEVICE_PROFILES).doc(dev._id).update({
      data: { reminded_maintenance_date: dev.next_maintenance_date, updated_at: now }
    });
    await trySendSubscribe(SUB_TEMPLATE_TYPES.MAINTENANCE_REMINDER, dev.customer_openid,
      'pages/booking/booking', { thing1: { value: '设备保养提醒' }, time1: { value: String(dev.next_maintenance_date || '').slice(0, 10) } });
  }
  await writeAudit(db, {
    actor_openid: 'SYSTEM', role: 'system', action: 'cron_maintenance_reminder',
    target_collection: COLLECTIONS.DEVICE_PROFILES, after: { window_days: 7, sent }
  });
  return ok({ job: CRON_JOBS.MAINTENANCE_REMINDER, scanned: res.data.length, sent });
}

/** 6-4b：库存预警 —— spare_parts.warn_threshold 高于可用库存汇总 */
async function stockAlert() {
  const parts = await db.collection(COLLECTIONS.SPARE_PARTS)
    .where({ status: 'on', warn_threshold: _.gt(0) })
    .limit(100)
    .get();

  let alerts = 0;
  for (const part of parts.data || []) {
    const batches = await db.collection(COLLECTIONS.STOCK_BATCHES)
      .where({ part_id: part._id, status: 'active' })
      .limit(200)
      .get();
    const available = (batches.data || []).reduce((sum, b) => sum + (b.available || 0), 0);
    if (available < part.warn_threshold) {
      await sendNotification(db, {
        to_role: 'admin', type: 'stock_alert',
        title: '库存预警',
        content: '备件 ' + part.part_name + '(' + part.part_no + ') 可用库存 ' + available + '，低于预警阈值 ' + part.warn_threshold + '。',
        ref_type: 'spare_part', ref_id: part._id
      });
      alerts += 1;
      await trySendSubscribe(SUB_TEMPLATE_TYPES.STOCK_ALERT, process.env.SYSTEM_ADMIN_OPENID,
        'pages/store/store', { thing1: { value: '库存预警通知' }, number1: { value: String(available) } });
    }
  }
  await writeAudit(db, {
    actor_openid: 'SYSTEM', role: 'system', action: 'cron_stock_alert',
    target_collection: COLLECTIONS.SPARE_PARTS, after: { alerts }
  });
  return ok({ job: CRON_JOBS.STOCK_ALERT, scanned: parts.data.length, alerts });
}

/** 6-4c：支付对账 —— 支付超时疑似流水标记 + 通知管理员人工核查（不擅自取消） */
async function payReconcile() {
  const now = new Date();
  const deadline = new Date(now.getTime() - 30 * 60 * 1000);
  const flows = await db.collection(COLLECTIONS.PAYMENT_FLOWS)
    .where({ status: 'pending', created_at: _.lt(deadline) })
    .limit(100)
    .get();

  let flagged = 0;
  for (const flow of flows.data || []) {
    if (flow.reconcile_flag) continue; // 幂等
    await db.collection(COLLECTIONS.PAYMENT_FLOWS).doc(flow._id).update({
      data: { reconcile_flag: 'unverified', reconcile_at: now }
    });
    flagged += 1;
  }
  if (flagged) {
    await sendNotification(db, {
      to_role: 'admin', type: 'system',
      title: '支付对账提醒',
      content: '有 ' + flagged + ' 笔支付流水超时未确认（30 分钟），请核查微信支付商户后台。',
      ref_type: 'system', ref_id: 'pay_reconcile'
    });
  }
  await writeAudit(db, {
    actor_openid: 'SYSTEM', role: 'system', action: 'cron_pay_reconcile',
    target_collection: COLLECTIONS.PAYMENT_FLOWS, after: { timeout_min: 30, flagged }
  });
  return ok({ job: CRON_JOBS.PAY_RECONCILE, scanned: flows.data.length, flagged });
}

/** 6-4d：报告清理 —— 作废/超保留期报告归档标记；导出链接过期标记 */
async function reportCleanup() {
  const now = new Date();
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 3600 * 1000);

  const revoked = await db.collection(COLLECTIONS.REPORTS)
    .where({ status: 'revoked', archived: _.neq(true) })
    .limit(100)
    .get();
  const expired = await db.collection(COLLECTIONS.REPORTS)
    .where({ status: 'valid', created_at: _.lt(cutoff), archived: _.neq(true) })
    .limit(100)
    .get();

  let archivedCount = 0;
  for (const r of revoked.data || []) {
    await db.collection(COLLECTIONS.REPORTS).doc(r._id).update({ data: { archived: true, archived_at: now } });
    archivedCount += 1;
  }
  for (const r of expired.data || []) {
    await db.collection(COLLECTIONS.REPORTS).doc(r._id).update({ data: { archived: true, archived_at: now } });
    archivedCount += 1;
  }

  // 导出记录过期链接
  const exports = await db.collection(COLLECTIONS.EXPORT_RECORDS)
    .where({ status: 'active', expires_at: _.lt(now) })
    .limit(100)
    .get();
  let expiredExports = 0;
  for (const ex of exports.data || []) {
    await db.collection(COLLECTIONS.EXPORT_RECORDS).doc(ex._id).update({ data: { status: 'expired' } });
    expiredExports += 1;
  }

  await writeAudit(db, {
    actor_openid: 'SYSTEM', role: 'system', action: 'cron_report_cleanup',
    target_collection: COLLECTIONS.REPORTS,
    after: { retention_days: RETENTION_DAYS, archived_count: archivedCount, expired_exports: expiredExports }
  });
  return ok({ job: CRON_JOBS.REPORT_CLEANUP, archived_count: archivedCount, expired_exports: expiredExports });
}

/** 调用 subscribe 云函数发送订阅消息（内部密钥；未配置跳过并记日志） */
async function trySendSubscribe(template_type, touser_openid, page, data) {
  if (!touser_openid) return;
  const key = process.env.SUBSCRIBE_INTERNAL_KEY;
  if (!key) return;
  try {
    await cloud.callFunction({
      name: 'subscribe',
      data: { action: 'subscribe.send', _internal_key: key, template_type, touser_openid, page, data }
    });
  } catch (e) {
    console.error('[cron] send subscribe error:', e.message);
  }
}

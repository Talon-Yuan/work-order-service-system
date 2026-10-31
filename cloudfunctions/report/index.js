/**
 * report 云函数 — 任务 5-3b：服务报告 PDF 生成（云函数端模板渲染）
 *  - 仅工单关联角色（客户/负责人/工程师/管理员）可生成/查看；生成动作写审计；
 *  - 报告要素：设备信息 / 工单信息 / 处理方案（work_steps 步骤+照片清单） / 处理结果（成本、验收） / 双签（客户签名 + 工程师/负责人签名）
 *  - PDF 存云存储私有读（workorder-files/reports/），数据库 reports 仅存 fileID/摘要，不存敏感全文；
 *  - 客户端经 report.get 换取私有读临时链接，可导出。
 */
const cloud = require('wx-server-sdk');
const PDFDocument = require('pdfkit');
const { ok, fail } = require('./common/response');
const { ACTIONS, COLLECTIONS, WO_STATUS, REPORT_STATUS } = require('./common/constants');
const { cleanInput } = require('./common/security');
const { authGuard } = require('./common/authGuard');
const { writeAudit, sendNotification, genNo } = require('./common/workflow');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
  const action = event && event.action;
  if (action === 'report.generate') return generateReport(event);
  if (action === 'report.get') return getReport(event);
  return fail(400, 'UNKNOWN_ACTION');
};

/** 行级过滤 + 工单关联校验（含越权拒绝） */
async function loadWorkOrder(ctx, workOrderId) {
  const woRes = await ctx.db.collection(COLLECTIONS.WORK_ORDERS)
    .where(Object.assign({}, ctx.rowFilter, { _id: workOrderId })).limit(1).get();
  if (!woRes.data.length) return null;
  return woRes.data[0];
}

/** 5-3b-1：生成服务报告 PDF */
async function generateReport(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      work_order_id: { type: 'string', max: 64, required: true },
      conclusion: { type: 'string', max: 1000, default: '' } // 处理结论（可覆盖）
    });
  } catch (e) {
    return fail(400, 'INVALID_PARAMS');
  }
  const ctx = await authGuard(event, { action: ACTIONS.REPORT_GENERATE });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db, openid, role } = ctx;

  try {
    const wo = await loadWorkOrder(ctx, p.work_order_id);
    if (!wo) return fail(404, 'WORK_ORDER_NOT_FOUND');

    // 状态要求：已验收/已闭环才允许生成最终报告；驳回中不允许
    if (![WO_STATUS.ACCEPTED, WO_STATUS.CLOSED].includes(wo.status)) {
      return fail(409, 'WO_STATUS_FORBIDS_REPORT');
    }
    // 重复生成：同一工单已存在报告时拒绝（防覆盖；如需重生成走 report.revoke 先作废）
    const dupRes = await db.collection(COLLECTIONS.REPORTS)
      .where({ work_order_id: wo._id, status: REPORT_STATUS.VALID }).limit(1).get();
    if (dupRes.data.length) return fail(409, 'REPORT_EXISTS');

    // 聚合施工步骤（处理方案）
    const stepsRes = await db.collection(COLLECTIONS.WORK_STEPS)
      .where({ work_order_id: wo._id }).orderBy('step_no', 'asc').limit(50).get();
    const steps = stepsRes.data;

    // 生成 PDF 字节
    const pdfBuffer = await buildPdf(wo, steps, p.conclusion);

    // 私有读存储：workorder-files/reports/ 随机名
    const reportNo = genNo('RPT');
    const cloudPath = 'workorder-files/reports/' + reportNo + '.pdf';
    const upRes = await cloud.uploadFile({
      cloudPath,
      fileContent: pdfBuffer,
      contentType: 'application/pdf'
    });
    const fileId = upRes.fileID;

    // 写入 reports（仅存元数据，不存 PDF 全文）
    const now = new Date();
    const addRes = await db.collection(COLLECTIONS.REPORTS).add({
      data: {
        report_no: reportNo,
        work_order_id: wo._id,
        work_order_no: wo.work_order_no,
        customer_openid: wo.customer_openid,
        engineer_openid: wo.engineer_openid || '',
        status: REPORT_STATUS.VALID,
        file_id: fileId,
        file_name: reportNo + '.pdf',
        summary: {
          device_name: wo.device_name || '',
          service_type: wo.service_type || '',
          conclusion: p.conclusion || '',
          total_cost_fen: wo.total_cost_fen || 0,
          step_count: steps.length,
          accepted: !!(wo.acceptance && wo.acceptance.type === 'accepted'),
          accepted_at: (wo.acceptance && wo.acceptance.accepted_at) || null
        },
        created_by_openid: openid,
        created_at: now,
        updated_at: now
      }
    });
    const reportId = addRes._id;

    // 回写工单 report_id
    await db.collection(COLLECTIONS.WORK_ORDERS).doc(wo._id).update({
      data: { report_id: reportId, updated_at: now }
    });

    // 审计
    await writeAudit(db, {
      actor_openid: openid, role,
      action: 'generate', target_collection: COLLECTIONS.REPORTS, target_id: reportId,
      after: { report_no: reportNo, work_order_id: wo._id, file_id: fileId }
    });

    // 通知客户：服务报告已生成（可查看/导出）
    if (wo.customer_openid && wo.customer_openid !== openid) {
      await sendNotification(db, {
        receiver_openid: wo.customer_openid, type: 'report',
        title: '服务报告已生成', content: '工单 ' + wo.work_order_no + ' 的服务报告已生成，可在线查看或导出 PDF。',
        ref_type: 'work_order', ref_id: wo._id
      });
    }

    return ok({ report_id: reportId, report_no: reportNo, file_id: fileId, status: REPORT_STATUS.VALID });
  } catch (e) {
    console.error('[report] generate error:', e);
    return fail(500, 'INTERNAL: generate report failed');
  }
}

/** 5-3b-2：查看报告（私有读临时链接，仅关联角色） */
async function getReport(event) {
  let p;
  try {
    p = cleanInput(event || {}, {
      report_id: { type: 'string', max: 64, required: true },
      max_age: { type: 'number', min: 60, max: 86400, default: 1800 }
    });
  } catch (e) {
    return fail(400, 'INVALID_PARAMS');
  }
  const ctx = await authGuard(event, { action: ACTIONS.REPORT_READ });
  if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
  const { db, openid, role } = ctx;
  try {
    const repRes = await db.collection(COLLECTIONS.REPORTS).where({ _id: p.report_id }).limit(1).get();
    if (!repRes.data.length) return fail(404, 'REPORT_NOT_FOUND');
    const rep = repRes.data[0];

    // 越权拒绝：非关联角色不可读取
    const wo = await loadWorkOrder(ctx, rep.work_order_id);
    if (!wo) return fail(403, 'WO_NOT_ACCESSIBLE');
    const related = [wo.customer_openid, wo.engineer_openid, wo.owner_openid];
    if (role !== 'admin' && related.indexOf(openid) < 0) {
      return fail(403, 'REPORT_NOT_YOURS');
    }

    // 私有读临时链接（不落库公开 URL）
    const tres = await cloud.getTempFileURL({ fileList: [rep.file_id], maxAge: p.max_age });
    const item = (tres.fileList || [])[0];
    if (!item || item.status !== 0 || !item.tempFileURL) return fail(500, 'TEMP_URL_FAILED');

    return ok({
      report_id: rep._id,
      report_no: rep.report_no,
      work_order_no: rep.work_order_no,
      status: rep.status,
      summary: rep.summary || {},
      file_name: rep.file_name,
      temp_file_url: item.tempFileURL,
      expire_in: p.max_age
    });
  } catch (e) {
    console.error('[report] get error:', e);
    return fail(500, 'INTERNAL: get report failed');
  }
}

/** 云函数端 PDF 模板渲染（含设备/工单/方案/结果/双签） */
async function buildPdf(wo, steps, conclusion) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const fmt = (fen) => '¥' + ((Number(fen) || 0) / 100).toFixed(2);
    const fmtDate = (d) => {
      if (!d) return '';
      const dt = new Date(d);
      const pad = (n) => String(n).padStart(2, '0');
      return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate()) + ' ' + pad(dt.getHours()) + ':' + pad(dt.getMinutes());
    };

    // 页眉
    doc.fontSize(18).fillColor('#1a1a1a').text('售后服务报告', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor('#666').text('Service Report · ' + (wo.work_order_no || ''), { align: 'center' });
    doc.moveDown(0.8);
    doc.strokeColor('#ccc').lineWidth(1).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.8);

    // 一、设备与工单信息
    doc.fontSize(13).fillColor('#1a1a1a').text('一、设备与工单信息');
    doc.moveDown(0.3);
    doc.fontSize(10.5).fillColor('#333');
    const infoRows = [
      ['工单号', wo.work_order_no || ''],
      ['服务类型', wo.service_type || ''],
      ['设备名称', wo.device_name || ''],
      ['工单状态', wo.status || ''],
      ['创建时间', fmtDate(wo.created_at)],
      ['完成时间', fmtDate(wo.completed_at || (wo.acceptance && wo.acceptance.accepted_at))]
    ];
    infoRows.forEach(([k, v]) => {
      doc.text(k + '：' + v, { lineGap: 4 });
    });
    doc.moveDown(0.6);

    // 二、处理方案（步骤明细）
    doc.fontSize(13).fillColor('#1a1a1a').text('二、处理方案（施工步骤）');
    doc.moveDown(0.3);
    if (!steps.length) {
      doc.fontSize(10.5).fillColor('#333').text('（无步骤记录）');
    } else {
      steps.forEach((s) => {
        doc.fontSize(10.5).fillColor('#333').text(
          s.step_no + '. ' + (s.label || s.name || '') + ' — ' + (s.status || 'pending') + '  ' +
          (s.finished_at ? fmtDate(s.finished_at) : (s.started_at ? fmtDate(s.started_at) : '')),
          { lineGap: 3 }
        );
        if (s.remark) doc.fontSize(10).fillColor('#555').text('   备注：' + s.remark, { lineGap: 3 });
        if (s.photos && s.photos.length) {
          doc.fontSize(9.5).fillColor('#888').text('   现场照片：' + s.photos.length + ' 张（fileID 列表，可经 upload.tempUrl 查看）', { lineGap: 3 });
        }
        doc.moveDown(0.2);
      });
    }
    doc.moveDown(0.6);

    // 三、处理结果与费用
    doc.fontSize(13).fillColor('#1a1a1a').text('三、处理结果与费用');
    doc.moveDown(0.3);
    doc.fontSize(10.5).fillColor('#333');
    const costRows = [
      ['人工费', fmt(wo.labor_fee_fen)],
      ['交通费', fmt(wo.transport_fee_fen)],
      ['配件费', fmt(wo.parts_cost_fen)],
      ['合计', fmt(wo.total_cost_fen)]
    ];
    costRows.forEach(([k, v]) => doc.text(k + '：' + v, { lineGap: 4 }));
    doc.moveDown(0.2);
    doc.text('验收结果：' + (wo.acceptance && wo.acceptance.type === 'accepted'
      ? ('客户已验收（评分 ' + (wo.acceptance.rating || '-') + '/5）' + (wo.acceptance.result ? '，意见：' + wo.acceptance.result : ''))
      : '未验收'), { lineGap: 4 });
    if (conclusion) doc.text('处理结论：' + conclusion, { lineGap: 4 });
    doc.moveDown(0.8);

    // 四、双签
    doc.fontSize(13).fillColor('#1a1a1a').text('四、双方签字确认');
    doc.moveDown(0.5);
    doc.fontSize(10.5).fillColor('#333');
    const signerLabel = {
      customer: '客户签字',
      engineer: '工程师签字',
      owner: '负责人签字'
    };
    doc.text('客户签字：' + (wo.acceptance && wo.acceptance.type === 'accepted'
      ? '（客户电子签名已存证 fileID: ' + (wo.acceptance.signature_file_id || '') + '）' : '——'));
    doc.moveDown(0.8);
    doc.text('工程师签字：' + (wo.engineer_openid ? '（服务端已记录工程师身份）' : '——'));
    doc.moveDown(0.8);
    doc.text('负责人签字：' + (wo.owner_openid ? '（服务端已记录负责人身份）' : '——'));
    doc.moveDown(0.8);

    // 页脚
    doc.strokeColor('#ccc').lineWidth(1).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor('#999').text('本报告由系统生成，仅限工单关联人员查看。生成时间：' + fmtDate(new Date()), { align: 'center' });

    doc.end();
  });
}

module.exports = { main: exports.main, buildPdf };

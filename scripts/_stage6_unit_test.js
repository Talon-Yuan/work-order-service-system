/**
 * _stage6_unit_test.js — 阶段6 验收模拟单测（Node fixture）
 * 由 scripts/verify_stage6.py 调用，输出 JSON: { total, passed, checks:[{name,pass,detail}] }
 * 通过 Module._load 拦截 wx-server-sdk，使用内存 FakeDb 跑通
 * logistics / subscribe / cron 三个云函数的关键链路。
 */
const Module = require('module');
const path = require('path');

/* ---------------- Fake Cloud / FakeDb ---------------- */
const STORE = {};
const openapiSent = [];
let nextId = 1;
let currentOpenid = '';

function seed(name, docs) {
  STORE[name] = (docs || []).map((d) => ({ _id: 'id_' + (nextId++), ...d }));
}
function clear() {
  for (const k of Object.keys(STORE)) delete STORE[k];
}
function collectionRows(name) { return STORE[name] || []; }

function matchValue(dv, cond) {
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    const keys = Object.keys(cond);
    if (keys.some((k) => k.startsWith('$'))) {
      return keys.every((k) => {
        const v = cond[k];
        if (k === '$gt') return dv > v;
        if (k === '$gte') return dv >= v;
        if (k === '$lt') return dv < v;
        if (k === '$lte') return dv <= v;
        if (k === '$neq') return dv !== v;
        if (k === '$and') return v.every((sub) => matchValue(dv, sub));
        return true;
      });
    }
  }
  return dv === cond;
}
function matchDoc(cond, doc) {
  return Object.entries(cond).every(([k, v]) => {
    if (k === '_id') return doc._id === v;
    if (k.startsWith('subscribe_templates.')) {
      const parts = k.split('.');
      let cur = doc;
      for (let i = 0; i < parts.length - 1; i++) cur = cur && cur[parts[i]];
      return cur ? matchValue(cur[parts[parts.length - 1]], v) : matchValue(undefined, v);
    }
    return matchValue(doc[k], v);
  });
}

class FakeDb {
  constructor() {
    this.command = {
      gt: (v) => ({ $gt: v }),
      gte: (v) => ({ $gte: v, and: (c) => ({ $and: [{ $gte: v }, c] }) }),
      lt: (v) => ({ $lt: v }),
      lte: (v) => ({ $lte: v }),
      neq: (v) => ({ $neq: v })
    };
  }
  collection(name) { return new Query(name); }
}
class Query {
  constructor(name) { this.name = name; this._where = {}; this._limit = Infinity; }
  where(cond) { this._where = cond || {}; return this; }
  limit(n) { this._limit = n; return this; }
  async get() {
    let rows = collectionRows(this.name).filter((d) => matchDoc(this._where, d));
    if (this._limit !== Infinity) rows = rows.slice(0, this._limit);
    return { data: rows.map((r) => ({ ...r })) };
  }
  async add({ data }) {
    const doc = { _id: 'id_' + (nextId++), ...data };
    STORE[this.name] = STORE[this.name] || [];
    STORE[this.name].push(doc);
    return { _id: doc._id };
  }
  doc(id) { return new Doc(this.name, id); }
}
class Doc {
  constructor(name, id) { this.name = name; this.id = id; }
  async get() {
    const r = collectionRows(this.name).find((d) => d._id === this.id);
    return { data: r ? { ...r } : null };
  }
  async update({ data }) {
    const r = collectionRows(this.name).find((d) => d._id === this.id);
    if (r) {
      // 支持点号路径：'subscribe_templates.xxx' 写为嵌套字段
      for (const [k, v] of Object.entries(data)) {
        if (k.indexOf('.') >= 0) {
          const parts = k.split('.');
          let cur = r;
          for (let i = 0; i < parts.length - 1; i++) {
            if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
            cur = cur[parts[i]];
          }
          cur[parts[parts.length - 1]] = v;
        } else {
          r[k] = v;
        }
      }
    }
    return { stats: { updated: r ? 1 : 0 } };
  }
}

const fakeCloud = {
  DYNAMIC_CURRENT_ENV: 'test-env',
  init() {},
  database() { return new FakeDb(); },
  getWXContext() { return { OPENID: currentOpenid, APPID: 'wx-test', UNIONID: 'union-1' }; },
  openapi: {
    subscribeMessage: {
      send: async (arg) => { openapiSent.push(arg); return { errcode: 0, msgid: 'mock_msg_' + openapiSent.length }; }
    }
  },
  callFunction: async ({ name, data }) => {
    return { result: { code: 0, msg: 'ok', data: { mocked: true, called: name, action: data && data.action } } };
  }
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return fakeCloud;
  return origLoad.apply(this, arguments);
};

/* ---------------- 加载被测云函数 ---------------- */
const base = path.join(__dirname, '..');
const constants = require(path.join(base, 'cloudfunctions', 'common', 'constants.js'));
const logistics = require(path.join(base, 'cloudfunctions', 'logistics', 'index.js'));
const logisticsClient = require(path.join(base, 'cloudfunctions', 'logistics', 'common', 'logisticsClient.js'));
const subscribe = require(path.join(base, 'cloudfunctions', 'subscribe', 'index.js'));
const cron = require(path.join(base, 'cloudfunctions', 'cron', 'index.js'));

/* ---------------- 断言收集 ---------------- */
const checks = [];
function check(name, pass, detail) { checks.push({ name, pass: !!pass, detail: detail || '' }); }

async function call(fn, event) {
  const out = await fn.main(event);
  return out || {};
}

/* ---------------- 数据预置 ---------------- */
function seedBase() {
  clear();
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 3600 * 1000);
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
  const nextWeek = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
  seed('users', [
    { _id: 'u_cust', _openid: 'openid_customer', role: 'customer', name: '客户A' },
    { _id: 'u_cust_b', _openid: 'openid_customer_b', role: 'customer', name: '客户B' },
    { _id: 'u_owner', _openid: 'openid_owner', role: 'owner', name: '老板' },
    { _id: 'u_admin', _openid: 'openid_admin', role: 'admin', name: '管理员' },
    { _id: 'u_eng', _openid: 'openid_engineer', role: 'engineer', name: '工程师' }
  ]);
  seed('orders', [
    { _id: 'o1', order_no: 'WO20261001001', _openid: 'openid_customer', status: 'shipped', pay_fen: 10000 },
    { _id: 'o2', order_no: 'WO20261001002', _openid: 'openid_customer', status: 'shipped', pay_fen: 20000 }
  ]);
  seed('device_profiles', [{
    _id: 'd1', customer_openid: 'openid_customer', owner_openid: 'openid_owner',
    device_name: '净水器A', serial_no: 'SN001', status: 'active',
    next_maintenance_date: tomorrow, reminded_maintenance_date: null
  }]);
  seed('spare_parts', [
    { _id: 'sp1', part_name: '滤芯', part_no: 'LX-01', status: 'on', warn_threshold: 5 },
    { _id: 'sp2', part_name: '水泵', part_no: 'SB-02', status: 'on', warn_threshold: 3 }
  ]);
  seed('stock_batches', [
    { _id: 'b1', part_id: 'sp1', status: 'active', available: 2 },
    { _id: 'b2', part_id: 'sp2', status: 'active', available: 10 }
  ]);
  seed('payment_flows', [
    { _id: 'pf1', order_id: 'o2', order_no: 'WO20261001002', amount_fen: 20000, trade_state: 'NOTPAY', status: 'pending', created_at: hourAgo },
    { _id: 'pf2', order_id: 'o1', order_no: 'WO20261001001', amount_fen: 10000, trade_state: 'SUCCESS', status: 'success', created_at: now }
  ]);
  seed('reports', [
    { _id: 'r1', report_no: 'RPT001', work_order_id: 'w1', status: 'revoked', archived: false, created_at: new Date(now.getTime() - 200 * 24 * 3600 * 1000) },
    { _id: 'r2', report_no: 'RPT002', work_order_id: 'w2', status: 'valid', archived: false, created_at: now }
  ]);
  seed('export_records', [
    { _id: 'e1', export_type: 'workorders', status: 'active', expires_at: yesterday },
    { _id: 'e2', export_type: 'invoices', status: 'active', expires_at: nextWeek }
  ]);
}

/* ================= 用例 ================= */
async function runAll() {
  seedBase();

  /* U1 常量与权限矩阵 */
  const A = constants.ACTIONS, LS = constants.LOGISTICS_STATUS, ST = constants.SUB_TEMPLATE_TYPES, CJ = constants.CRON_JOBS;
  check('U1a 阶段6动作码齐全',
    A.LOGISTICS_CREATE && A.LOGISTICS_TRACE && A.LOGISTICS_LIST && A.LOGISTICS_CALLBACK &&
    A.SUBSCRIBE_TEMPLATES && A.SUBSCRIBE_ALLOW && A.SUBSCRIBE_LIST && A.SUBSCRIBE_SEND && A.CRON_RUN,
    'ACTIONS 阶段6动作码');
  check('U1b 物流四态', LS.PENDING && LS.IN_TRANSIT && LS.DELIVERED && LS.EXCEPTION, 'LOGISTICS_STATUS');
  check('U1c 订阅六模板', ['APPOINTMENT_APPROVED', 'VISIT_REMINDER', 'WORK_ORDER_PROGRESS', 'LOGISTICS_DYNAMIC', 'STOCK_ALERT', 'MAINTENANCE_REMINDER'].every((k) => ST[k]), 'SUB_TEMPLATE_TYPES');
  check('U1d 定时四任务', ['MAINTENANCE_REMINDER', 'STOCK_ALERT', 'PAY_RECONCILE', 'REPORT_CLEANUP'].every((k) => CJ[k]), 'CRON_JOBS');
  const caps = constants.ROLE_CAPS;
  check('U1e 客户物流/订阅只读权限',
    caps.customer.includes(A.LOGISTICS_TRACE) && caps.customer.includes(A.LOGISTICS_LIST) &&
    caps.customer.includes(A.SUBSCRIBE_TEMPLATES) && caps.customer.includes(A.SUBSCRIBE_ALLOW) && caps.customer.includes(A.SUBSCRIBE_LIST),
    'customer caps');
  check('U1f 客户不得越权发货/发送订阅',
    !caps.customer.includes(A.LOGISTICS_CREATE) && !caps.customer.includes(A.SUBSCRIBE_SEND),
    'customer 无 LOGISTICS_CREATE/SUBSCRIBE_SEND');
  check('U1g owner 可发货、admin 全权限',
    caps.owner.includes(A.LOGISTICS_CREATE) && (caps.admin.includes('*') || (caps.admin.includes(A.SUBSCRIBE_SEND) && caps.admin.includes(A.CRON_RUN))),
    'owner/admin caps');

  /* U2 物流建单（快递100 未配置 → 明确降级提示） */
  delete process.env.KUAIDI100_KEY;
  delete process.env.KUAIDI100_CUSTOMER;
  currentOpenid = 'openid_owner';
  let out = await call(logistics, { action: 'logistics.create', order_id: 'o1', carrier: 'SF', tracking_no: 'SF1234567890', carrier_name: '顺丰速运' });
  const w0 = collectionRows('waybills')[0];
  check('U2a 发货建单成功（owner）', out.code === 0 && !!out.data.waybill_id, JSON.stringify(out));
  check('U2b 运单落库字段正确',
    !!w0 && w0.status === 'pending' && w0.customer_openid === 'openid_customer' && w0.order_id === 'o1' &&
    w0.tracking_no === 'SF1234567890' && w0.subscribed === false,
    JSON.stringify(w0));
  check('U2c 密钥未配置明确提示', out.data.warning === 'LOGISTICS_NOT_CONFIGURED', 'warning=' + out.data.warning);
  check('U2d 订单补齐物流号', collectionRows('orders').find((o) => o._id === 'o1').logistics_no === 'SF1234567890', 'order logistics_no');

  /* U3 幂等 */
  out = await call(logistics, { action: 'logistics.create', order_id: 'o1', carrier: 'SF', tracking_no: 'SF1234567890' });
  check('U3 重复建单幂等', out.code === 0 && out.data.existed === true && collectionRows('waybills').length === 1, JSON.stringify(out.data));

  /* U4 回调验签失败 */
  process.env.KUAIDI100_KEY = 'testkey';
  process.env.KUAIDI100_CUSTOMER = 'testcustomer';
  process.env.SUBSCRIBE_INTERNAL_KEY = 'internal-test';
  const badBody = JSON.stringify({ lastResult: { nu: 'SF1234567890', com: 'SF', state: 3, data: [{ time: '2026-10-30T10:00:00', context: '已签收' }] } });
  out = await call(logistics, { action: 'logistics.callback', body: badBody, sign: 'DEADBEEF' });
  check('U4 验签失败拒绝且不落库', out.code === 401 && w0.status === 'pending', JSON.stringify(out));

  /* U5 回调成功 → 签收联动订单 */
  const deliveredBody = JSON.stringify({ lastResult: { nu: 'SF1234567890', com: 'SF', state: 3, data: [{ time: '2026-10-30T10:00:00', context: '已签收' }] } });
  const goodSign = logisticsClient.md5(deliveredBody + process.env.KUAIDI100_KEY + process.env.KUAIDI100_CUSTOMER);
  out = await call(logistics, { action: 'logistics.callback', body: deliveredBody, sign: goodSign });
  const w0b = collectionRows('waybills').find((w) => w._id === w0._id);
  check('U5a 验签通过回调写入', out.code === 0, JSON.stringify(out));
  check('U5b 状态 pending→delivered', w0b.status === 'delivered', 'status=' + w0b.status);
  check('U5c 轨迹合并落库', Array.isArray(w0b.raw_trace) && w0b.raw_trace.length === 1, 'trace=' + w0b.raw_trace.length);
  check('U5d 订单联动 shipped→completed', collectionRows('orders').find((o) => o._id === 'o1').status === 'completed', 'order status');
  check('U5e 站内物流通知写入', collectionRows('notifications').some((n) => n.type === 'logistics'), 'notifications logistics');

  /* U6 回调运输中状态不误联动 */
  const inTransitBody = JSON.stringify({ lastResult: { nu: 'YT8888888', com: 'YT', state: 0, data: [{ time: '2026-10-30T09:00:00', context: '运输中' }] } });
  await call(logistics, { action: 'logistics.create', order_id: 'o2', carrier: 'YT', tracking_no: 'YT8888888' });
  const w2 = collectionRows('waybills').find((w) => w.order_id === 'o2');
  const sign2 = logisticsClient.md5(inTransitBody + process.env.KUAIDI100_KEY + process.env.KUAIDI100_CUSTOMER);
  out = await call(logistics, { action: 'logistics.callback', body: inTransitBody, sign: sign2 });
  const w2b = collectionRows('waybills').find((w) => w._id === w2._id);
  check('U6a 状态 pending→in_transit', out.code === 0 && w2b.status === 'in_transit', 'status=' + w2b.status);
  check('U6b 运输中不误签收订单', collectionRows('orders').find((o) => o._id === 'o2').status === 'shipped', 'order status=shipped');

  /* U7 客户查询本人物流 */
  currentOpenid = 'openid_customer';
  out = await call(logistics, { action: 'logistics.trace', waybill_id: w0._id });
  check('U7 客户可查本人运单轨迹',
    out.code === 0 && out.data.waybill.status === 'delivered' && out.data.trace.length === 1,
    JSON.stringify(out.data && out.data.waybill));

  /* U8 越权查询（客户B查客户A的运单） */
  currentOpenid = 'openid_customer_b';
  out = await call(logistics, { action: 'logistics.trace', waybill_id: w0._id });
  check('U8 非本人查询被行级隔离拒绝', out.code === 404 && out.msg === 'WAYBILL_NOT_FOUND', JSON.stringify(out));

  /* U9 按订单号查 */
  currentOpenid = 'openid_customer';
  out = await call(logistics, { action: 'logistics.trace', order_id: 'o1' });
  check('U9 按 order_id 定位运单', out.code === 0 && out.data.waybill.order_id === 'o1', JSON.stringify(out.data && out.data.waybill));

  /* U10 订阅模板列表 */
  process.env.SUB_TMPL_APPOINTMENT_APPROVED = 'tmpl_a';
  process.env.SUB_TMPL_VISIT_REMINDER = 'tmpl_b';
  process.env.SUB_TMPL_WORK_ORDER_PROGRESS = 'tmpl_c';
  process.env.SUB_TMPL_LOGISTICS_DYNAMIC = 'tmpl_d';
  process.env.SUB_TMPL_STOCK_ALERT = 'tmpl_e';
  process.env.SUB_TMPL_MAINTENANCE_REMINDER = 'tmpl_f';
  out = await call(subscribe, { action: 'subscribe.templates' });
  check('U10 模板列表 6 类且 ID 来自环境变量',
    out.code === 0 && out.data.items.length === 6 && out.data.items.every((it) => it.configured === true),
    'items=' + (out.data && out.data.items && out.data.items.length));

  /* U11 授权登记 */
  out = await call(subscribe, { action: 'subscribe.allow', template_types: ['work_order_progress', 'logistics_dynamic'] });
  const cust = collectionRows('users').find((u) => u._openid === 'openid_customer');
  check('U11 授权登记成功',
    out.code === 0 && cust.subscribe_templates && cust.subscribe_templates.logistics_dynamic instanceof Date,
    JSON.stringify(cust.subscribe_templates));

  /* U12 订阅列表 */
  out = await call(subscribe, { action: 'subscribe.list' });
  const itemD = out.data.items.find((it) => it.template_type === 'logistics_dynamic');
  const itemS = out.data.items.find((it) => it.template_type === 'stock_alert');
  check('U12 授权状态展示', out.code === 0 && itemD.granted === true && itemS.granted === false, JSON.stringify(out.data.items));

  /* U13 内部密钥发送（已授权模板） */
  out = await call(subscribe, {
    action: 'subscribe.send', _internal_key: 'internal-test', template_type: 'logistics_dynamic',
    touser_openid: 'openid_customer', page: 'pages/logistics/index',
    data: { thing1: { value: '物流状态更新' }, phrase1: { value: '已签收' } }
  });
  check('U13 内部密钥发送成功', out.code === 0 && !!out.data.msg_id && openapiSent.length === 1, JSON.stringify(out));

  /* U14 无内部密钥非 admin 拒绝 */
  currentOpenid = 'openid_customer';
  out = await call(subscribe, {
    action: 'subscribe.send', template_type: 'logistics_dynamic', touser_openid: 'openid_customer',
    data: { thing1: { value: 'x' }, phrase1: { value: 'y' } }
  });
  check('U14 普通用户发送被拒', out.code === 403, JSON.stringify(out));

  /* U15 未授权模板拒绝 */
  out = await call(subscribe, {
    action: 'subscribe.send', _internal_key: 'internal-test', template_type: 'stock_alert',
    touser_openid: 'openid_customer', data: { thing1: { value: '库存预警' }, number1: { value: '2' } }
  });
  check('U15 未授权模板返回 NOT_SUBSCRIBED', out.code === 403 && out.msg === 'NOT_SUBSCRIBED', JSON.stringify(out));

  /* U16 cron 保养提醒（防重复） */
  currentOpenid = 'openid_admin';
  out = await call(cron, { action: 'cron.run', job: 'maintenance_reminder' });
  const dev = collectionRows('device_profiles').find((d) => d._id === 'd1');
  const maintCount1 = collectionRows('notifications').filter((n) => n.type === 'maintenance').length;
  check('U16a 保养提醒写入通知', out.code === 0 && maintCount1 === 1, 'alerts=' + JSON.stringify(out.data));
  check('U16b 防重复标记落库', dev.reminded_maintenance_date && String(dev.reminded_maintenance_date) === String(dev.next_maintenance_date), 'reminded=' + dev.reminded_maintenance_date);
  await call(cron, { action: 'cron.run', job: 'maintenance_reminder' });
  check('U16c 再次运行不重复提醒', collectionRows('notifications').filter((n) => n.type === 'maintenance').length === 1, 'count=' + collectionRows('notifications').filter((n) => n.type === 'maintenance').length);

  /* U17 cron 库存预警 */
  out = await call(cron, { action: 'cron.run', job: 'stock_alert' });
  check('U17 库存预警：低库存备件告警且正常件不告警',
    out.code === 0 && out.data.alerts === 1 && collectionRows('notifications').some((n) => n.type === 'stock_alert'),
    JSON.stringify(out.data));

  /* U18 cron 支付对账 */
  out = await call(cron, { action: 'cron.run', job: 'pay_reconcile' });
  const pf1 = collectionRows('payment_flows').find((p) => p._id === 'pf1');
  const pf2 = collectionRows('payment_flows').find((p) => p._id === 'pf2');
  check('U18 超时未支付流水标记待核、成功流水不动',
    out.code === 0 && pf1.reconcile_flag === 'unverified' && !pf2.reconcile_flag,
    JSON.stringify(out.data));

  /* U19 cron 报告清理（仅归档不删除） */
  out = await call(cron, { action: 'cron.run', job: 'report_cleanup' });
  const r1 = collectionRows('reports').find((r) => r._id === 'r1');
  const r2 = collectionRows('reports').find((r) => r._id === 'r2');
  const e1 = collectionRows('export_records').find((e) => e._id === 'e1');
  const e2 = collectionRows('export_records').find((e) => e._id === 'e2');
  check('U19a 作废/超期报告归档、有效报告保留',
    out.code === 0 && r1.archived === true && r2.archived !== true && r1._id && r2._id, JSON.stringify(out.data));
  check('U19b 过期导出链接置 expired、未到期保留',
    e1.status === 'expired' && e2.status === 'active', 'e1=' + e1.status + ' e2=' + e2.status);

  /* U20 mapState 状态映射（近40种→4内部态） */
  check('U20a 签收/退签映射',
    logisticsClient.mapState(3) === 'delivered' && logisticsClient.mapState(4) === 'exception', '3->delivered,4->exception');
  check('U20b 在途/揽收/派件/转投/清关→in_transit',
    [0, 1, 5, 7, 8].every((s) => logisticsClient.mapState(s) === 'in_transit'), '0/1/5/7/8->in_transit');
  check('U20c 疑难/退回→exception', logisticsClient.mapState(2) === 'exception' && logisticsClient.mapState(6) === 'exception', '2/6->exception');
  check('U20d 未知状态兜底 pending', logisticsClient.mapState(9) === 'pending' && logisticsClient.mapState(undefined) === 'pending', '9/undefined->pending');

  /* U21 mask 脱敏 */
  check('U21 日志脱敏', logisticsClient.mask('SF1234567890').indexOf('****') > 0 && logisticsClient.mask('13812341234') !== '13812341234', logisticsClient.mask('SF1234567890'));
}

(async () => {
  await runAll();
  const passed = checks.filter((c) => c.pass).length;
  const result = JSON.stringify({ total: checks.length, passed, checks }, null, 2);
  const fs = require('fs');
  fs.writeFileSync(path.join(__dirname, '_stage6_unit_out.json'), result, 'utf-8');
  console.log('DONE total=' + checks.length + ' passed=' + passed);
})().catch((e) => {
  console.error('FIXTURE_ERROR:', e && e.stack || e);
  process.exit(2);
});

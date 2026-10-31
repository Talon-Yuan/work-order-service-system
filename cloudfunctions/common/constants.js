/**
 * constants.js — 云函数公共常量（阶段 2/3 扩展版，对应项目书 V3.1）
 * 安全红线：常量仅含集合名/角色/权限码等非敏感元数据，严禁存放任何密钥。
 * V3.1 新增集合：timezone_cities（时区城市字典）、export_records（导出记录）、
 *              sms_codes（Web 登录短信验证码临时凭证，内部集合）
 */
const COLLECTIONS = {
  USERS: 'users',
  DEVICE_PROFILES: 'device_profiles',
  ENGINEER_SCHEDULES: 'engineer_schedules',
  APPOINTMENTS: 'appointments',
  SPARE_PARTS: 'spare_parts',
  STOCK_BATCHES: 'stock_batches',
  INVENTORY_FLOWS: 'inventory_flows',
  ORDERS: 'orders',
  WAYBILLS: 'waybills',
  WORK_ORDERS: 'work_orders',
  WORK_STEPS: 'work_steps',
  NOTIFICATIONS: 'notifications',
  REPORTS: 'reports',
  EVALUATIONS: 'evaluations',
  VISIT_PLANS: 'visit_plans',
  KNOWLEDGE_BASE: 'knowledge_base',
  SYSTEM_CONFIG: 'system_config',
  AUDIT_LOGS: 'audit_logs',
  PAYMENT_FLOWS: 'payment_flows',
  TOKEN_BLACKLIST: 'token_blacklist',
  // —— V3.1 新增 ——
  TIMEZONE_CITIES: 'timezone_cities',
  EXPORT_RECORDS: 'export_records',
  SMS_CODES: 'sms_codes',
  // —— V3.1 阶段5 新增 ——
  UPLOAD_LOGS: 'upload_logs'           // 上传登记（容量/审计/归属校验依据）
};

const ROLES = {
  CUSTOMER: 'customer', // 客户：预约/下单/查看自己工单
  OWNER: 'owner',       // 门店/服务商：审批预约、派单、回访
  ENGINEER: 'engineer', // 工程师：施工、步骤上报、验收
  ADMIN: 'admin'        // 管理员：系统配置、成本参数、审计
};

/** 权限码（按接口登记；未登记权限的接口在 authGuard 统一拒绝） */
const ACTIONS = {
  LOGIN: 'auth.login',
  HOME_OVERVIEW: 'home.overview',
  BOOKING_CREATE: 'booking.create',
  BOOKING_LIST: 'booking.list',
  BOOKING_APPROVE: 'booking.approve',
  WO_CREATE: 'wo.create',
  WO_ASSIGN: 'wo.assign',
  WO_START: 'wo.start',
  WO_PAUSE: 'wo.pause',
  WO_COMPLETE: 'wo.complete',
  WO_VERIFY: 'wo.verify',
  WO_LIST: 'wo.list',
  WO_DETAIL: 'wo.detail',
  ORDER_CREATE: 'order.create',
  ORDER_PAY: 'order.pay',
  ORDER_LIST: 'order.list',
  PAY_CALLBACK: 'pay.callback', // 仅微信支付回调，服务端签名验证后调用
  STORE_LIST: 'store.list',
  KNOWLEDGE_LIST: 'knowledge.list',
  KNOWLEDGE_DETAIL: 'knowledge.detail',
  CONFIG_READ: 'config.read',
  CONFIG_WRITE: 'config.write', // 仅 admin
  EVAL_CREATE: 'eval.create',
  REPORT_READ: 'report.read',
  // —— V3.1 新增动作 ——
  EXPORT_CREATE: 'export.create',       // 处理记录导出（行级过滤 + 审计 + 限流）
  EXPORT_LIST: 'export.list',           // 查询本人导出记录
  SCHEDULE_CALENDAR: 'schedule.calendar', // 排班日历（忙/闲）
  SCHEDULE_CREATE: 'schedule.create',   // 排班写入（owner/admin）
  TIMEZONE_LIST: 'timezone.list',       // 时区城市字典
  USER_PROFILE_UPDATE: 'user.profile.update', // 用户时区/城市偏好
  WEB_BIND: 'auth.bind',                // Web 账号与小程序 openid 绑定
  // —— V3.1 阶段4：备件库存与商城订单 ——
  SPARE_PART_DETAIL: 'sparepart.detail', // 备件详情（商城公开，登录可读）
  SPARE_PART_CREATE: 'sparepart.create', // 备件目录新增（管理端）
  SPARE_PART_UPDATE: 'sparepart.update', // 备件目录修改（管理端）
  SPARE_PART_ALERT: 'sparepart.alert',   // 库存预警查询（管理端，按阈值计算）
  BATCH_LIST: 'batch.list',              // 批次列表（管理端）
  BATCH_CREATE: 'batch.create',          // 批次新增（管理端，自动入库流水）
  BATCH_UPDATE: 'batch.update',          // 批次修改（管理端，描述字段）
  SN_ADD: 'sn.add',                      // 序列号添加（管理端，自动入库流水）
  SN_UPDATE: 'sn.update',                // 序列号状态变更（管理端，流水可追溯）
  INVENTORY_IN: 'inventory.in',          // 入库（管理端）
  INVENTORY_OUT: 'inventory.out',        // 出库（管理端/工程师施工领料）
  INVENTORY_CHECK: 'inventory.check',    // 盘点（管理端）
  INVENTORY_FLOWS: 'inventory.flows',    // 库存流水查询（管理端/工程师）
  CART_GET: 'cart.get',                  // Web 服务端购物车读取
  CART_SAVE: 'cart.save',                // Web 服务端购物车写入
  ORDER_DETAIL: 'order.detail',          // 订单详情（本人/管理端）
  ORDER_CANCEL: 'order.cancel',          // 取消订单（仅待支付，释放预留）
  ORDER_SHIP: 'order.ship',              // 发货（管理端，预留转出库）
  ORDER_REFUND: 'order.refund',          // 退款登记（管理端，人工退款）
  INVOICE_REQUEST: 'invoice.request',    // 客户发起开票请求
  INVOICE_REGISTER: 'invoice.register',  // 发票登记（管理端）
  INVOICE_LIST: 'invoice.list',          // 发票列表（本人/管理端）
  PAY_QUERY: 'pay.query',                // 支付主动查单（补单 5/30/120/1440 分钟）
  // —— V3.1 阶段5：工单闭环与服务报告 ——
  WO_TRANSITION: 'wo.transition',      // 服务端状态流转（不可跳级）
  WO_CLOSE: 'wo.close',                // 工单闭环（accepted 才可 closed）
  WO_PROGRESS: 'wo.progress',          // 施工进度追加（带审计）
  WO_ACCEPT: 'wo.accept',              // 客户电子签名验收（openid 匹配）
  WO_REJECT: 'wo.reject',              // 客户驳回（openid 匹配）
  UPLOAD_FILE: 'upload.file',          // 文件上传（魔数/大小/内容安全/私有读）
  REPORT_GENERATE: 'report.generate',  // 生成服务报告 PDF（私有读）
  // —— V3.1 阶段6：物流追踪与订阅消息 ——
  LOGISTICS_CREATE: 'logistics.create',    // 发货创建物流单 + 订阅轨迹（owner/admin）
  LOGISTICS_TRACE: 'logistics.trace',      // 轨迹查询（客户本人/管理端，限流 + 脱敏）
  LOGISTICS_LIST: 'logistics.list',        // 物流单列表（客户本人/管理端）
  LOGISTICS_CALLBACK: 'logistics.callback', // 快递100 订阅回调（服务端验签，不走用户鉴权）
  SUBSCRIBE_ALLOW: 'subscribe.allow',      // 用户授权登记订阅模板（wx.requestSubscribeMessage 后上报）
  SUBSCRIBE_LIST: 'subscribe.list',        // 查询本人订阅授权状态
  SUBSCRIBE_TEMPLATES: 'subscribe.templates', // 查询可订阅模板（含 template_id，非密钥）
  SUBSCRIBE_SEND: 'subscribe.send',        // 服务端发送订阅消息（内部密钥或 admin；防伪造）
  CRON_RUN: 'cron.run',                    // 定时任务手动触发（admin，供验收/补跑）
  // —— V3.1 阶段7：数据看板 / 成本统计 / Excel 导出 ——
  DASHBOARD_OVERVIEW: 'dashboard.overview', // 看板聚合（KPI + 趋势，云函数聚合）
  COST_STATS_READ: 'cost.stats.read',       // 成本统计（汇总/近6月/构成/TOP，行级过滤）
  COST_CONFIG_READ: 'cost.config.read',     // 成本参数读取（owner/admin）
  COST_CONFIG_WRITE: 'cost.config.write',   // 成本参数写入（仅 admin，带审计）
  // —— V3.1 阶段8：服务评价与回访 / 知识库 ——
  EVAL_LIST: 'eval.list',                   // 评价列表（客户本人 / 被评工程师 / 管理全量）
  EVAL_STATS: 'eval.stats',                 // 满意度统计（内部角色，客户无）
  VISIT_CREATE: 'visit.create',             // 创建回访计划（owner/admin）
  VISIT_LIST: 'visit.list',                 // 回访计划列表（客户本人 / 管理全量）
  VISIT_RECORD: 'visit.record',             // 回访结果记录（owner/admin）
  KNOWLEDGE_CREATE: 'knowledge.create',     // 知识库文章创建（engineer/owner/admin）
  KNOWLEDGE_UPDATE: 'knowledge.update',     // 知识库文章更新（engineer/owner/admin）
  KNOWLEDGE_DELETE: 'knowledge.delete',     // 知识库文章删除（engineer/owner/admin）
  KNOWLEDGE_FROM_WO: 'knowledge.from_wo'    // 工单一键沉淀案例（engineer/owner/admin）
};

/**
 * 角色 -> 权限码集合；'*' 表示全部（仅 admin）
 * V3.1 矩阵扩展：
 *  - 三档可见：客户=本人(customer_openid)、工程师=派单(engineer_openid)、负责人/管理员=全量
 *  - 导出权限：客户导出本人、工程师导出派单、负责人/管理员导出全量
 *  - 日历排班：客户可看匿名化空闲日历（发起预约），工程师看本人，负责人/管理员看全员并可写排班
 * 前端仅按角色渲染入口（体验层），服务端 authGuard 二次校验（真实防线）。
 */
const ROLE_CAPS = {
  [ROLES.CUSTOMER]: [
    ACTIONS.LOGIN, ACTIONS.HOME_OVERVIEW,
    ACTIONS.BOOKING_CREATE, ACTIONS.BOOKING_LIST,
    ACTIONS.WO_LIST, ACTIONS.WO_DETAIL,
    ACTIONS.ORDER_CREATE, ACTIONS.ORDER_PAY, ACTIONS.ORDER_LIST,
    ACTIONS.ORDER_DETAIL, ACTIONS.ORDER_CANCEL,
    ACTIONS.STORE_LIST, ACTIONS.SPARE_PART_DETAIL,
    ACTIONS.CART_GET, ACTIONS.CART_SAVE,
    ACTIONS.INVOICE_REQUEST, ACTIONS.INVOICE_LIST, ACTIONS.PAY_QUERY,
    ACTIONS.KNOWLEDGE_LIST, ACTIONS.KNOWLEDGE_DETAIL,
    ACTIONS.EVAL_CREATE, ACTIONS.EVAL_LIST, ACTIONS.VISIT_LIST, ACTIONS.REPORT_READ,
    ACTIONS.EXPORT_CREATE, ACTIONS.EXPORT_LIST,
    ACTIONS.SCHEDULE_CALENDAR, ACTIONS.TIMEZONE_LIST, ACTIONS.USER_PROFILE_UPDATE,
    // 阶段6：客户可查本人物流/订阅模板/授权管理（发送走服务端内部密钥）
    ACTIONS.LOGISTICS_TRACE, ACTIONS.LOGISTICS_LIST,
    ACTIONS.SUBSCRIBE_TEMPLATES, ACTIONS.SUBSCRIBE_ALLOW, ACTIONS.SUBSCRIBE_LIST,
    ACTIONS.DASHBOARD_OVERVIEW
  ],
  [ROLES.OWNER]: [
    ACTIONS.LOGIN, ACTIONS.HOME_OVERVIEW,
    ACTIONS.BOOKING_LIST, ACTIONS.BOOKING_APPROVE, ACTIONS.BOOKING_CREATE,
    ACTIONS.WO_CREATE, ACTIONS.WO_ASSIGN, ACTIONS.WO_LIST, ACTIONS.WO_DETAIL,
    ACTIONS.ORDER_LIST, ACTIONS.ORDER_DETAIL, ACTIONS.ORDER_CANCEL,
    ACTIONS.ORDER_SHIP, ACTIONS.ORDER_REFUND,
    ACTIONS.STORE_LIST, ACTIONS.SPARE_PART_DETAIL,
    ACTIONS.SPARE_PART_CREATE, ACTIONS.SPARE_PART_UPDATE, ACTIONS.SPARE_PART_ALERT,
    ACTIONS.BATCH_LIST, ACTIONS.BATCH_CREATE, ACTIONS.BATCH_UPDATE,
    ACTIONS.SN_ADD, ACTIONS.SN_UPDATE,
    ACTIONS.INVENTORY_IN, ACTIONS.INVENTORY_OUT, ACTIONS.INVENTORY_CHECK, ACTIONS.INVENTORY_FLOWS,
    ACTIONS.CART_GET, ACTIONS.CART_SAVE,
    ACTIONS.INVOICE_REQUEST, ACTIONS.INVOICE_REGISTER, ACTIONS.INVOICE_LIST,
    ACTIONS.PAY_QUERY,
    ACTIONS.KNOWLEDGE_LIST, ACTIONS.KNOWLEDGE_DETAIL,
    ACTIONS.REPORT_READ, ACTIONS.CONFIG_READ,
    ACTIONS.EXPORT_CREATE, ACTIONS.EXPORT_LIST,
    ACTIONS.SCHEDULE_CALENDAR, ACTIONS.SCHEDULE_CREATE,
    ACTIONS.TIMEZONE_LIST, ACTIONS.USER_PROFILE_UPDATE, ACTIONS.WEB_BIND,
    // 阶段6：经营者可发货建物流单/查全部物流/订阅管理（发送走内部密钥，不直接开放）
    ACTIONS.LOGISTICS_CREATE, ACTIONS.LOGISTICS_TRACE, ACTIONS.LOGISTICS_LIST,
    ACTIONS.SUBSCRIBE_TEMPLATES, ACTIONS.SUBSCRIBE_ALLOW, ACTIONS.SUBSCRIBE_LIST,
    ACTIONS.DASHBOARD_OVERVIEW, ACTIONS.COST_STATS_READ, ACTIONS.COST_CONFIG_READ,
    // 阶段8：负责人管理评价统计与回访计划，维护知识库
    ACTIONS.EVAL_LIST, ACTIONS.EVAL_STATS,
    ACTIONS.VISIT_CREATE, ACTIONS.VISIT_LIST, ACTIONS.VISIT_RECORD,
    ACTIONS.KNOWLEDGE_CREATE, ACTIONS.KNOWLEDGE_UPDATE, ACTIONS.KNOWLEDGE_DELETE, ACTIONS.KNOWLEDGE_FROM_WO
  ],
  [ROLES.ENGINEER]: [
    ACTIONS.LOGIN, ACTIONS.HOME_OVERVIEW,
    ACTIONS.WO_LIST, ACTIONS.WO_DETAIL,
    ACTIONS.WO_PROGRESS, ACTIONS.WO_TRANSITION, ACTIONS.WO_CLOSE, // 阶段5：进度追加/状态流转/闭环
    ACTIONS.UPLOAD_FILE, ACTIONS.REPORT_GENERATE,                 // 阶段5：施工照片上传/生成报告
    ACTIONS.WO_START, ACTIONS.WO_PAUSE, ACTIONS.WO_COMPLETE, ACTIONS.WO_VERIFY,
    ACTIONS.STORE_LIST, ACTIONS.SPARE_PART_DETAIL,
    ACTIONS.INVENTORY_OUT, ACTIONS.INVENTORY_FLOWS,
    ACTIONS.KNOWLEDGE_LIST, ACTIONS.KNOWLEDGE_DETAIL,
    ACTIONS.REPORT_READ,
    ACTIONS.EXPORT_CREATE, ACTIONS.EXPORT_LIST,
    ACTIONS.SCHEDULE_CALENDAR, ACTIONS.TIMEZONE_LIST, ACTIONS.USER_PROFILE_UPDATE,
    // 阶段6：工程师可查物流与订阅模板（创建仅 owner/admin）
    ACTIONS.LOGISTICS_TRACE, ACTIONS.LOGISTICS_LIST,
    ACTIONS.SUBSCRIBE_LIST, ACTIONS.SUBSCRIBE_TEMPLATES,
    ACTIONS.DASHBOARD_OVERVIEW, ACTIONS.COST_STATS_READ,
    // 阶段8：工程师可查被评记录/统计，维护知识库（含工单沉淀）
    ACTIONS.EVAL_LIST, ACTIONS.EVAL_STATS,
    ACTIONS.KNOWLEDGE_CREATE, ACTIONS.KNOWLEDGE_UPDATE, ACTIONS.KNOWLEDGE_DELETE, ACTIONS.KNOWLEDGE_FROM_WO
  ],
  [ROLES.ADMIN]: ['*']
};

/** 知识库可见性 */
const VISIBILITY = { PUBLIC: 'public', INTERNAL: 'internal' };

/** 工单状态（V3.1 阶段5 状态机：待处理→施工中→待验收→已验收/驳回→已闭环） */
const WO_STATUS = {
  PENDING: 'pending',             // 待处理
  PROCESSING: 'processing',       // 施工中
  PENDING_ACCEPTANCE: 'pending_acceptance', // 待验收
  ACCEPTED: 'accepted',           // 已验收
  REJECTED: 'rejected',           // 驳回（可重新施工或直接闭环）
  CLOSED: 'closed'                // 已闭环
};

/** 服务报告状态 */
const REPORT_STATUS = {
  VALID: 'valid',     // 有效（可查看/导出）
  REVOKED: 'revoked'  // 已作废（重生成时先作废旧报告）
};

/** 预约状态 */
const APPOINTMENT_STATUS = {
  PENDING: 'pending', APPROVED: 'approved', REJECTED: 'rejected',
  IN_PROGRESS: 'in_progress', COMPLETED: 'completed', CANCELLED: 'cancelled'
};

/** 排班槽位状态（日历忙/闲着色） */
const SLOT_STATUS = {
  FREE: 'free',        // 空闲（可预约）
  FULL: 'full',        // 已排满（capacity 用尽）
  OCCUPIED: 'occupied',// 已被预约占用
  CLOSED: 'closed'     // 排班关闭
};

/** 物流标准化状态（快递100 近 40 种原始状态映射后的内部阶段，6-1/6-2） */
const LOGISTICS_STATUS = {
  PENDING: 'pending',      // 未揽收/已下单
  IN_TRANSIT: 'in_transit',// 运输中（已揽收/派送中/转运等）
  DELIVERED: 'delivered',  // 已签收
  EXCEPTION: 'exception'   // 异常（疑难件/退回/超时未签收等）
};

/** 订阅消息模板类型（6 类，template_id 仅存云函数环境变量，前端零密钥） */
const SUB_TEMPLATE_TYPES = {
  APPOINTMENT_APPROVED: 'appointment_approved',  // 预约通过
  VISIT_REMINDER: 'visit_reminder',              // 上门提醒
  WORK_ORDER_PROGRESS: 'work_order_progress',    // 工单进度
  LOGISTICS_DYNAMIC: 'logistics_dynamic',        // 物流动态
  STOCK_ALERT: 'stock_alert',                    // 库存预警
  MAINTENANCE_REMINDER: 'maintenance_reminder'   // 保养提醒
};

/** 定时任务 job 名（cron 云函数，6-4） */
const CRON_JOBS = {
  MAINTENANCE_REMINDER: 'maintenance_reminder',
  STOCK_ALERT: 'stock_alert',
  PAY_RECONCILE: 'pay_reconcile',
  REPORT_CLEANUP: 'report_cleanup'
};

/** 会话 Token 有效期（秒）：access 2h / refresh 7d */
const TOKEN_TTL = {
  ACCESS: 2 * 60 * 60,
  REFRESH: 7 * 24 * 60 * 60
};

module.exports = {
  COLLECTIONS, ROLES, ACTIONS, ROLE_CAPS, VISIBILITY,
  WO_STATUS, REPORT_STATUS, APPOINTMENT_STATUS, SLOT_STATUS, TOKEN_TTL,
  LOGISTICS_STATUS, SUB_TEMPLATE_TYPES, CRON_JOBS
};

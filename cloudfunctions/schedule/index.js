/**
 * schedule 云函数 — 排班日历 + 冲突检测 + 创建预约（阶段 3，对应项目书 3-1/3-2 与 16.5/16.6）
 * actions：
 *  - calendar         排班日历：engineer_schedules + appointments 合并，返回忙/闲着色数据
 *  - create           排班写入（owner/admin）：联合唯一（工程师+日期+槽位）防并发超卖
 *  - appointmentCreate 创建预约：排班覆盖校验 → 区间重叠冲突检测 → 事务落库
 *  - timezone.list    时区城市字典查询（timezone_cities 集合）
 * 安全红线：
 *  - 身份零信任：customer_openid 一律取会话身份，拒绝前端传入
 *  - 冲突检测在服务端执行（区间重叠公式 s1<e2 && s2<e1），客户端仅展示
 *  - 时间统一以北京时间（GMT+8）存储，前端 Intl.DateTimeFormat 换算展示
 */
const { ok, fail } = require('./common/response');
const { ACTIONS, COLLECTIONS, APPOINTMENT_STATUS, SLOT_STATUS, ROLES } = require('./common/constants');
const { cleanInput } = require('./common/security');
const { authGuard } = require('./common/authGuard');

const DEFAULT_CAPACITY = 1;

/** 解析 'HH:mm' -> 分钟数 */
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/** 解析槽位 'HH:mm-HH:mm' -> { startMin, endMin }；非法返回 null */
function parseSlot(slot) {
  const parts = String(slot || '').split('-');
  if (parts.length !== 2) return null;
  const s = toMinutes(parts[0]); const e = toMinutes(parts[1]);
  if (s === null || e === null || e <= s) return null;
  return { startMin: s, endMin: e };
}

/** 区间重叠检测（半开区间 [s1,e1) 与 [s2,e2)）：s1 < e2 && s2 < e1 */
function hasOverlap(s1, e1, s2, e2) {
  return s1 < e2 && s2 < e1;
}

/** 生成预约单号 */
function genAppointmentNo() {
  const t = new Date();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return 'AP' + t.getFullYear() + pad(t.getMonth() + 1) + pad(t.getDate())
    + pad(t.getHours()) + pad(t.getMinutes()) + pad(t.getSeconds())
    + Math.floor(1000 + Math.random() * 9000);
}

/** 服务端解析负责人：排班记录 org -> users(role=owner, org 匹配) */
async function resolveOwnerOpenid(db, engineerOrg) {
  if (!engineerOrg) return '';
  try {
    const res = await db.collection(COLLECTIONS.USERS)
      .where({ role: ROLES.OWNER, org: engineerOrg, status: 'active' }).limit(1).get();
    return res.data.length ? (res.data[0].openid || res.data[0]._openid) : '';
  } catch (e) {
    return '';
  }
}

exports.main = async (event) => {
  let p;
  try {
    p = cleanInput(event || {}, {
      action: { type: 'string', max: 32 },
      engineer_openid: { type: 'string', max: 64 },
      month: { type: 'string', max: 7 },
      date: { type: 'string', max: 10 },
      slot: { type: 'string', max: 32 },
      slots: { type: 'array' },
      capacity: { type: 'number' },
      status: { type: 'string', max: 16 },
      device_id: { type: 'string', max: 64 },
      service_type: { type: 'string', max: 64 },
      description: { type: 'string', max: 500 },
      timezone: { type: 'string', max: 64 },
      city: { type: 'string', max: 64 }
    });
  } catch (e) {
    return fail(400, 'INVALID_PARAMS');
  }
  const action = p.action || '';

  // ---------- 排班日历（忙/闲） ----------
  if (action === 'calendar') {
    const ctx = await authGuard(event, { action: ACTIONS.SCHEDULE_CALENDAR });
    if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
    const { db, role } = ctx;
    const month = /^\d{4}-\d{2}$/.test(p.month || '') ? p.month : new Date().toISOString().slice(0, 7);
    const date = p.date || '';
    try {
      const schedCond = { status: 'open' };
      if (p.engineer_openid) schedCond.engineer_openid = p.engineer_openid;
      const dateCond = date ? { date } : { date: db.RegExp({ regexp: '^' + month + '-', options: 'i' }) };
      const schedRes = await db.collection(COLLECTIONS.ENGINEER_SCHEDULES)
        .where(Object.assign({}, schedCond, dateCond)).limit(1000).get();

      const apptCond = { status: db.command.neq(APPOINTMENT_STATUS.CANCELLED) };
      if (p.engineer_openid) apptCond.engineer_openid = p.engineer_openid;
      const apptRes = await db.collection(COLLECTIONS.APPOINTMENTS)
        .where(Object.assign({}, apptCond, dateCond)).limit(1000).get();

      // 合并：排班槽位 + 预约占用
      const dayMap = {};
      const occupiedKeys = new Set(apptRes.data.map((a) => a.date + '|' + (a.time_slot || a.slot || '')));
      for (const s of schedRes.data) {
        const key = s.date + '|' + s.slot;
        let st = SLOT_STATUS.FREE;
        if (occupiedKeys.has(key)) st = SLOT_STATUS.OCCUPIED;
        else if ((s.booked || 0) >= (s.capacity || DEFAULT_CAPACITY)) st = SLOT_STATUS.FULL;
        else if (s.status === 'closed') st = SLOT_STATUS.CLOSED;
        if (!dayMap[s.date]) dayMap[s.date] = [];
        // 客户视角匿名化：不暴露工程师 openid，仅标记可预约
        const entry = {
          slot: s.slot,
          status: st,
          capacity: s.capacity || DEFAULT_CAPACITY,
          booked: s.booked || 0
        };
        if (role !== ROLES.CUSTOMER) entry.engineer_openid = s.engineer_openid;
        dayMap[s.date].push(entry);
      }
      const days = Object.keys(dayMap).sort().map((d) => ({ date: d, slots: dayMap[d] }));
      return ok({ month, days });
    } catch (e) {
      console.error('[schedule][calendar] error:', e);
      return fail(500, 'INTERNAL: calendar failed');
    }
  }

  // ---------- 排班写入（owner/admin） ----------
  if (action === 'create') {
    const ctx = await authGuard(event, { action: ACTIONS.SCHEDULE_CREATE });
    if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
    const { db, role } = ctx;
    if (role !== ROLES.OWNER && role !== ROLES.ADMIN) return fail(403, 'FORBIDDEN');
    const engineer = p.engineer_openid || '';
    if (!engineer) return fail(400, 'MISSING_ENGINEER');
    const capacity = Math.max(1, Math.floor(p.capacity || DEFAULT_CAPACITY));
    const status = p.status === 'closed' ? 'closed' : 'open';
    const slots = Array.isArray(p.slots) ? p.slots : (p.slot ? [p.slot] : []);
    const dates = Array.isArray(p.slots) && p.date ? [p.date] : (p.date ? [p.date] : []);
    const plans = [];
    if (slots.length && dates.length) {
      for (const d of dates) for (const sl of slots) plans.push({ engineer, date: d, slot: sl });
    } else if (p.date && p.slot) {
      plans.push({ engineer, date: p.date, slot: p.slot });
    }
    if (!plans.length) return fail(400, 'MISSING_PLAN');
    const created = []; const conflicts = [];
    try {
      for (const plan of plans) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(plan.date)) { conflicts.push({ ...plan, reason: 'BAD_DATE' }); continue; }
        if (!parseSlot(plan.slot)) { conflicts.push({ ...plan, reason: 'BAD_SLOT' }); continue; }
        const dup = await db.collection(COLLECTIONS.ENGINEER_SCHEDULES)
          .where({ engineer_openid: plan.engineer, date: plan.date, slot: plan.slot }).limit(1).get();
        if (dup.data.length) {
          // 联合唯一冲突：不覆盖，返回冲突（防并发超卖）
          conflicts.push({ ...plan, reason: 'DUPLICATE' });
          continue;
        }
        const add = await db.collection(COLLECTIONS.ENGINEER_SCHEDULES).add({
          data: {
            engineer_openid: plan.engineer,
            date: plan.date,
            slot: plan.slot,
            capacity,
            booked: 0,
            status,
            org: p.org || ctx.user.org || '',
            created_by: ctx.openid,
            created_at: db.serverDate(),
            updated_at: db.serverDate()
          }
        });
        created.push({ ...plan, _id: add._id });
      }
      return ok({ created, conflicts, created_count: created.length, conflict_count: conflicts.length });
    } catch (e) {
      console.error('[schedule][create] error:', e);
      return fail(500, 'INTERNAL: schedule create failed');
    }
  }

  // ---------- 创建预约（冲突检测 + 事务落库） ----------
  if (action === 'appointmentCreate') {
    const ctx = await authGuard(event, { action: ACTIONS.BOOKING_CREATE });
    if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
    const { db, openid, role, user } = ctx;
    const engineer = p.engineer_openid || '';
    const date = p.date || '';
    const slot = p.slot || '';
    if (!engineer || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !parseSlot(slot)) {
      return fail(400, 'INVALID_BOOKING');
    }
    const device_id = p.device_id || '';
    const service_type = p.service_type || 'maintenance';
    if (!device_id) return fail(400, 'MISSING_DEVICE');
    const range = parseSlot(slot);

    try {
      // 1) 排班覆盖校验
      const sched = await db.collection(COLLECTIONS.ENGINEER_SCHEDULES)
        .where({ engineer_openid: engineer, date, slot, status: 'open' }).limit(1).get();
      if (!sched.data.length) return fail(422, 'NO_SCHEDULE');

      // 2) 时段冲突检测（区间重叠公式）：与当日全部非取消预约比对
      const appts = await db.collection(COLLECTIONS.APPOINTMENTS)
        .where({
          engineer_openid: engineer,
          date,
          status: db.command.neq(APPOINTMENT_STATUS.CANCELLED)
        }).limit(100).get();
      for (const a of appts.data) {
        const r = parseSlot(a.time_slot || a.slot || '');
        if (r && hasOverlap(range.startMin, range.endMin, r.startMin, r.endMin)) {
          return fail(409, 'SLOT_CONFLICT');
        }
      }
      const sdoc = sched.data[0];
      if ((sdoc.booked || 0) >= (sdoc.capacity || DEFAULT_CAPACITY)) return fail(409, 'SLOT_FULL');

      // 3) 负责人解析（服务端）：排班 org -> owner
      const ownerOpenid = await resolveOwnerOpenid(db, sdoc.org);

      // 4) 落库（事务）：appointments + 排班 booked+1（并发兜底依赖联合唯一索引/事务）
      const appointmentNo = genAppointmentNo();
      const tz = p.timezone || user.timezone || 'Asia/Shanghai';
      const city = p.city || user.city || '';
      const result = await db.runTransaction(async (transaction) => {
        const add = await transaction.collection(COLLECTIONS.APPOINTMENTS).add({
          data: {
            appointment_no: appointmentNo,
            customer_openid: openid,       // 服务端写入，拒绝前端传
            owner_openid: ownerOpenid,
            engineer_openid: engineer,
            device_id,
            service_type,
            description: p.description || '',
            service_date: date,            // 北京时间（GMT+8）存储
            time_slot: slot,
            status: APPOINTMENT_STATUS.PENDING,
            timezone: tz,
            city: city,
            created_at: db.serverDate(),
            updated_at: db.serverDate()
          }
        });
        await transaction.collection(COLLECTIONS.ENGINEER_SCHEDULES).doc(sdoc._id).update({
          data: { booked: (sdoc.booked || 0) + 1, updated_at: db.serverDate() }
        });
        return add._id;
      });

      // 5) 通知负责人（骨架）
      if (ownerOpenid) {
        await db.collection(COLLECTIONS.NOTIFICATIONS).add({
          data: {
            receiver_openid: ownerOpenid,
            type: 'appointment',
            title: 'appt.pendingTitle',
            content: appointmentNo + ' ' + date + ' ' + slot,
            ref_type: 'appointment',
            ref_id: result,
            is_read: false,
            created_at: db.serverDate()
          }
        });
      }
      await db.collection(COLLECTIONS.AUDIT_LOGS).add({
        data: {
          actor_openid: openid, action: 'booking.create', object_type: 'appointment', object_id: result,
          result: 'success', detail: { engineer_openid: engineer, date, slot }, created_at: db.serverDate()
        }
      });
      return ok({ appointment_id: result, appointment_no: appointmentNo, conflict_checked: true });
    } catch (e) {
      console.error('[schedule][appointmentCreate] error:', e);
      return fail(500, 'INTERNAL: appointment create failed');
    }
  }

  // ---------- 时区城市字典 ----------
  if (action === 'timezone.list') {
    const ctx = await authGuard(event, { action: ACTIONS.TIMEZONE_LIST });
    if (ctx.error) return fail(ctx.error.code, ctx.error.msg);
    const { db } = ctx;
    try {
      const res = await db.collection(COLLECTIONS.TIMEZONE_CITIES).limit(100).get();
      if (!res.data.length) {
        // 集合未种子化：提示前端以内置字典兜底（miniprogram/utils/timezone-cities.js）
        return ok({ list: [], seeded: false, hint: 'use builtin timezone-cities.js' });
      }
      return ok({ list: res.data.map((c) => ({
        _id: c._id, city: c.city, city_zh: c.city_zh, tz: c.tz,
        utc_offset: c.utc_offset, dst: c.dst || false
      })), seeded: true });
    } catch (e) {
      console.error('[schedule][timezone] error:', e);
      return fail(500, 'INTERNAL: timezone list failed');
    }
  }

  return fail(400, 'INVALID_ACTION');
};

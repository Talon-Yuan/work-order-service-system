// pages/schedule/schedule.js
// 阶段3：排班日历（月视图）
// 功能：工程师 × 日期格，忙/闲着色；点击空闲日期发起预约
// 数据来源：cloudfunctions/schedule 云函数（calendar action），前端零直连
const { t, apply } = require('../../utils/i18n');
const { callFunction } = require('../../utils/request');

const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

Page({
  data: {
    i18n: {},
    year: 0,
    month: 0,
    engineers: [],
    cells: [],          // [{date, day, busy, free, hasSchedule, items, isToday, weekend}]
    busyMap: {},        // { '2026-11-01::engid': true } 工程师粒度忙索引
    selected: null,
    loading: false,
  },

  onLoad() { apply(this, ['schedule']); },
  onShow() { apply(this, ['schedule']); },

  onReady() {
    const now = new Date();
    this.setData({ year: now.getFullYear(), month: now.getMonth() + 1 });
    this.loadCalendar();
  },

  // 上/下月切换
  prevMonth() { this.shiftMonth(-1); },
  nextMonth() { this.shiftMonth(1); },
  shiftMonth(delta) {
    const { year, month } = this.data;
    const d = new Date(year, month - 1 + delta, 1);
    this.setData({ year: d.getFullYear(), month: d.getMonth() + 1 });
    this.loadCalendar();
  },

  loadCalendar() {
    const { year, month } = this.data;
    this.setData({ loading: true });
    callFunction('schedule', {
      action: 'calendar',
      month: `${year}-${String(month).padStart(2, '0')}`,
    }).then((res) => {
      this.setData({ loading: false });
      if (!res || res.code !== 0) return;
      const { days, engineers } = res.data || {};
      this.renderCells(days || [], engineers || []);
    });
  },

  // 生成月视图格子：6 行 × 7 列（以周一为起始）
  // 忙/闲判定：该日期存在排班且含 FREE 槽位 -> 闲；存在但全部被占/关闭 -> 忙；无排班 -> 灰
  renderCells(days, engineers) {
    const { year, month } = this.data;
    const first = new Date(year, month - 1, 1);
    const daysInMonth = new Date(year, month, 0).getDate();
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    // 索引：date -> slots；busyMap：date::engineer -> 忙
    const info = {};
    const busyMap = {};
    for (const d of days) {
      info[d.date] = d.slots || [];
      for (const s of d.slots) {
        if (s.engineer_openid) busyMap[`${d.date}::${s.engineer_openid}`] = s.status !== 'FREE';
      }
    }
    let lead = (first.getDay() + 6) % 7;
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let day = 1; day <= daysInMonth; day++) {
      const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const slots = info[date] || [];
      let hasSchedule = slots.length > 0;
      let hasFree = slots.some((s) => s.status === 'FREE');
      cells.push({
        date,
        day,
        busy: hasSchedule && !hasFree,
        free: hasSchedule && hasFree,
        hasSchedule,
        items: [],
        isToday: date === todayStr,
        weekend: (first.getDay() + day - 1) % 7 === 0 || (first.getDay() + day - 1) % 7 === 6,
      });
    }
    while (cells.length % 7 !== 0) cells.push(null);
    this.setData({ cells, busyMap, engineers });
  },

  // 点击日期：无排班/已约满提示；空闲则弹工程师列表发起预约
  onTapCell(e) {
    const { date } = e.currentTarget.dataset;
    if (!date) return;
    const cell = this.data.cells.find((c) => c && c.date === date);
    if (!cell || !cell.hasSchedule) {
      wx.showToast({ title: t('noSchedule'), icon: 'none' });
      return;
    }
    if (cell.busy) {
      wx.showToast({ title: t('conflict'), icon: 'none' });
      return;
    }
    const engineers = this.data.engineers;
    this.setData({ selected: { date } });
    if (!engineers.length) {
      wx.showToast({ title: t('engineerSelect'), icon: 'none' });
      return;
    }
    wx.showActionSheet({
      itemList: engineers.map((x) => x.name || x.nickName || x._id),
      success: (r) => {
        const eng = engineers[r.tapIndex];
        const key = `${date}::${eng._id || eng.id || eng.engineerId}`;
        if (this.data.busyMap[key]) {
          wx.showToast({ title: t('conflict'), icon: 'none' });
          return;
        }
        wx.showModal({
          title: t('booking'),
          content: `${date} · ${eng.name || eng.nickName || eng._id}`,
          confirmText: t('submit'),
          cancelText: t('cancel'),
          success: (m) => {
            if (!m.confirm) return;
            this.createAppointment(date, eng);
          },
        });
      },
    });
  },

  createAppointment(date, eng) {
    const engineer_openid = eng._id || eng.id || eng.engineerId;
    callFunction('schedule', {
      action: 'appointmentCreate',
      engineer_openid,
      date,
      // 骨架默认 9:00-10:00 首空闲段；完整实现可扩展时段选择器
      slot: '09:00-10:00',
      // 骨架占位设备，正式接入设备档案选择器（device_profiles 云函数读取）
      device_id: 'DEMO-DEVICE-0001',
      service_type: 'maintenance',
      description: t('booking'),
    }).then((res) => {
      if (res && res.code === 0) {
        wx.showToast({ title: t('bookingSuccess'), icon: 'success' });
        this.loadCalendar();
      }
    });
  },
});

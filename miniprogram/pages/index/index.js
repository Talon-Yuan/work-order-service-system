// pages/index/index.js
const { t, apply } = require('../../utils/i18n');
const { callFunction } = require('../../utils/request');
Page({
  data: { i18n: {}, stats: { devices: 0, wos: 0, notifications: 0 } },
  onLoad() { apply(this, ['home','quick','myDevices','runningOrders','newBooking','partsMall','notifications']); },
  onShow() {
    apply(this, ['home','quick','myDevices','runningOrders','newBooking','partsMall','notifications']);
    callFunction('homeOverview', { _source: 'mini' }).then(res => {
      if (res.code === 0) this.setData({ stats: res.data });
    }).catch(() => {});
  },
  goBooking() { wx.navigateTo({ url: '/pages/booking/booking' }); },
  goStore() { wx.switchTab({ url: '/pages/store/store' }); },
  goWorkorders() { wx.switchTab({ url: '/pages/workorders/workorders' }); },
  goNotifications() { wx.navigateTo({ url: '/pages/notifications/notifications' }); },
});

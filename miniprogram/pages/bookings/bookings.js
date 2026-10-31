// pages/bookings/bookings.js
// 骨架页：核心链路占位，业务逻辑在后续阶段实现
const { t, apply } = require('../../utils/i18n');
const { callFunction } = require('../../utils/request');

Page({
  data: { i18n: {} },
  onLoad() { apply(this, ['myBooking']); },
  onShow() { apply(this, ['myBooking']); },
  onTapDemo() {
    const w = this.selectComponent('#toast');
    if (w && w.show) w.show(t('skeletonAction'));
  },
});

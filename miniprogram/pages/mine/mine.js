// pages/mine/mine.js
// 个人中心：阶段0 骨架 + 阶段6 物流追踪/订阅管理入口 + 阶段8 服务评价/知识库入口
const { t, apply } = require('../../utils/i18n');
const { callFunction } = require('../../utils/request');

Page({
  data: { i18n: {} },
  onLoad() { apply(this, ['mine', 'myLogistics', 'subscribeManage', 'myEvaluation', 'myKnowledge']); },
  onShow() { apply(this, ['mine', 'myLogistics', 'subscribeManage', 'myEvaluation', 'myKnowledge']); },
  onTapDemo() {
    const w = this.selectComponent('#toast');
    if (w && w.show) w.show(t('skeletonAction'));
  },
  onGoLogistics() { wx.navigateTo({ url: '/pages/logistics/logistics' }); },
  onGoSubscribe() { wx.navigateTo({ url: '/pages/subscribe/subscribe' }); },
  onGoDashboard() { wx.navigateTo({ url: '/pages/dashboard/dashboard' }); },
  onGoCost() { wx.navigateTo({ url: '/pages/cost/cost' }); },
  onGoExport() { wx.navigateTo({ url: '/pages/export/export' }); },
  onGoReview() { wx.navigateTo({ url: '/pages/review/review' }); },
  onGoKnowledge() { wx.navigateTo({ url: '/pages/knowledge/knowledge' }); },
});

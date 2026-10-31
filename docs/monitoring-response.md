---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 47431e7c58c84ae90ffa749d8fbb5d5f_89967070d46211f19fe5525400638852
    ReservedCode1: gFy6Ro943jroxr11uAeyDWsmZQefAtKT7vXuWcNAicv/uNvcDVAeCSyyeO0yurOS36zAkRESVa4aQRl+cL3xRIYFERkepgiQyJij2Ed5v32Y3nG3fRskfUI+mTnTmZJLH0X6gFvLjh+0lrRObQ+lFp8U4fp+Jd0mlzHowUCE1qPYnUi2X4+WckVooWA=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 47431e7c58c84ae90ffa749d8fbb5d5f_89967070d46211f19fe5525400638852
    ReservedCode2: gFy6Ro943jroxr11uAeyDWsmZQefAtKT7vXuWcNAicv/uNvcDVAeCSyyeO0yurOS36zAkRESVa4aQRl+cL3xRIYFERkepgiQyJij2Ed5v32Y3nG3fRskfUI+mTnTmZJLH0X6gFvLjh+0lrRObQ+lFp8U4fp+Jd0mlzHowUCE1qPYnUi2X4+WckVooWA=
---

# 上线后监控与响应（docs/monitoring-response.md）

> 微信售后服务平台 V3.1 · 阶段9（任务9-5）· 监控看板可用、告警有人响应
> 结论：告警指标、巡检周期、密钥轮换计划、响应预案已定义。

---

## 1. 告警指标

| 指标 | 告警阈值 | 采集方式 | 响应时限 |
|---|---|---|---|
| 支付回调成功率 | <99%（日粒度） | pay.callback 返回非2xx / 验签失败计数 → audit_logs | 2 小时内 |
| 云函数错误率 | 突增 > 3 倍基线（时粒度） | 云开发控制台函数日志 error 计数 | 2 小时内 |
| 异常登录 | 登录失败次数突增 / 同一 openid 高频失败 / token 黑名单命中 | login/index.js 失败计数 + audit_logs | 30 分钟内 |
| 越权尝试 | authGuard 403 频率异常（如单 IP/openid 大量 403） | audit_logs 403 计数 | 当日 |
| 库存负值/超卖告警 | inventory_flows 出现负库存操作被拒计数 | inventory/index.js 防超卖日志 | 当日 |
| 上传内容安全 | 内容违规命中次数 | upload 云函数 imgSecCheck/msgSecCheck 拒绝计数 | 当日 |
| 订阅消息发送失败 | 订阅消息发送失败率 > 5% | subscribe/index.js 失败计数 | 当日 |

## 2. 监控看板

- 云开发控制台：函数调用量、错误率、耗时、资源用量（日/周视图）
- 自定义看板：以 dashboard 云函数 + Web 管理端看板页承载业务指标（工单/订单/成本）
- 支付对账：T+1 对账脚本核对 payment_flows 与微信侧账单

## 3. 日志审计巡检

| 周期 | 动作 | 责任 |
|---|---|---|
| 每周 | 审计日志抽查：登录、支付、库存变更、审批、删除、上传、知识库写操作各抽 5 条核对 | 管理员 |
| 每周 | 403 越权尝试统计，确认无真实越权 | 管理员 |
| 每月 | 全量审计日志备份（导出 audit_logs） | 管理员 |
| 每季度 | 数据库权限矩阵复核（validate_schema.py + 云控制台） | 管理员/开发 |

## 4. 密钥轮换周期

| 密钥类型 | 轮换周期 | 轮换动作 |
|---|---|---|
| 微信 AppSecret | 90 天 | 登录 mp 后台重置 → 更新云函数环境变量 → 验证 login |
| APIv3 密钥 | 180 天 | 商户平台重置 → 更新环境变量 → 验证 pay.create/query/callback |
| 商户私钥/平台证书 | 证书到期前 30 天 | 重新申请证书 → 更新环境变量 → 验证回调验签 |
| 物流 key（快递100/极兔） | 180 天 | 服务商后台重置 → 更新环境变量 → 验证 logistics |
| 云开发数据库密码（如启用） | 90 天 | 控制台重置 → 更新连接配置 |
| Web 管理端会话密钥 | 90 天 | 更换 JWT/会话密钥 → 强制重新登录 |

## 5. 响应预案

### 5.1 密钥疑似泄漏
1. 立即在对应控制台轮换/作废密钥（AppSecret/APIv3/物流 key）。
2. 跑 `scripts/scan_secrets.py` 全量扫描，定位泄漏文件。
3. 更新 token_version 强制受影响会话下线。
4. 写审计记录（audit_logs 事件）。

### 5.2 支付回调成功率 <99%
1. 检查 pay.callback 错误日志（验签失败/解密失败/超时）。
2. 核对商户平台回调配置与云函数 HTTPS 触发器。
3. 确认订单状态机幂等（重放不重复入账）。
4. 恢复后更新告警阈值基线与审计。

### 5.3 云函数错误率突增
1. 查看控制台错误日志，定位函数与错误类型。
2. 若为入参异常：核对 cleanInput 与调用方；若为外部依赖：检查微信/物流/支付接口。
3. 必要时回滚最近一次部署（云函数版本管理）。
4. 记录事件与处理结论。

### 5.4 异常登录/越权尝试
1. 查看 audit_logs 登录失败与 403 记录，定位 openid/来源。
2. 黑名单命中则确认 token_blacklist 生效。
3. 若确认攻击：临时限流 + 通知用户改密 + 升级权限校验。
4. 每周巡检汇总趋势。

## 6. 值班与升级路径

- 一线：管理员（每日查看控制台告警）
- 二线：开发负责人（2 小时内响应，处理代码/配置问题）
- 升级：涉及资金/数据安全事件 30 分钟内升级至项目负责人并通知用户

*（内容由AI生成，仅供参考）*
*（内容由AI生成，仅供参考）*

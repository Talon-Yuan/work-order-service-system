---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 47431e7c58c84ae90ffa749d8fbb5d5f_d3bf2217d40b11f1a97752540064ee0f
    ReservedCode1: fYnKciYnI2gMI+V/7aIzZ0NUjfycbbCg1hxSyF7lnWT4rhGBwsZCzzda7bLf3L01VC6krkZBtNFRCRGktvZdrv7X51uQkIY0d3eQMT8HQxT13bn5bvWk3LTMpYk12OqY0GeiFA3wLBLAhT7Tu1VOmD9r3OclhaOYEMMnIC9GF20PNcfX/UCBRrXooQQ=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 47431e7c58c84ae90ffa749d8fbb5d5f_d3bf2217d40b11f1a97752540064ee0f
    ReservedCode2: fYnKciYnI2gMI+V/7aIzZ0NUjfycbbCg1hxSyF7lnWT4rhGBwsZCzzda7bLf3L01VC6krkZBtNFRCRGktvZdrv7X51uQkIY0d3eQMT8HQxT13bn5bvWk3LTMpYk12OqY0GeiFA3wLBLAhT7Tu1VOmD9r3OclhaOYEMMnIC9GF20PNcfX/UCBRrXooQQ=
---

# 数据库安全基线（docs/database-security.md）

> 微信售后服务平台 V3 · 阶段 0 · 与 schema.md 配套
> 基线核心：前端零密钥 / 数据库零全开 / 身份零信任 / 关键操作零直连 / 明文密码零存储

## 1. 数据库访问边界

| 访问通道 | 是否允许 | 说明 |
|---|---|---|
| 前端小程序 `wx.cloud.database()` 直连 | 禁止（除极少数公开只读目录） | 默认全部拒绝，逐集合最小授权 |
| Web 端浏览器直连 | 禁止 | 一律经云函数 callFunction |
| 云函数（管理端身份） | 允许 | 数据库操作只出现在云函数代码中 |
| 控制台手工操作 | 允许（需审计） | 由管理员在云开发控制台执行并登记 |

**零全开原则**：任何集合不得配置为 `"read": true, "write": true` 全开。逐集合按 schema.md「权限归属」配置。

## 2. 集合级规则矩阵（数据库安全规则示例）

| 集合 | read | write | 依据 |
|---|---|---|---|
| users | false | false | 云函数专属（login/authGuard） |
| notifications | `auth.openid == doc.receiver_openid` | false | openid 隔离 |
| device_profiles | 云函数专属 | false | 按 customer_openid / owner_openid 行级过滤 |
| appointments | 云函数专属 | false | 状态机在云函数 |
| spare_parts | 登录可读（公开目录） | false | 目录只读，写走云函数 |
| stock_batches / inventory_flows | false | false | 内部集合 |
| orders / waybills / work_orders | 云函数专属 | false | 行级过滤 + 状态机 |
| knowledge_base | public: 登录可读；internal: false | false | 两级可见性，internal 仅云函数角色过滤 |
| system_config / audit_logs / payment_flows / token_blacklist | false | false | 内部集合，仅云函数/管理端 |

> 即便集合配了公开只读规则，前端业务读写仍强制走云函数；数据库规则只是纵深防御最后一层。

## 3. 字段级防护

- 客户接口禁止输出：`cost_fen`、`system_config.value`、`openid`（仅内部需要）、`token_version`、审计字段。
- 云函数统一 `response.js` 白名单投影（pick fields），禁止整文档透传。
- 列表接口脱敏：手机号 `138****1234`，日志禁止明文手机号/身份证。
- internal 知识库文档 id 不得出现在客户可见接口响应中。

## 4. 查询与写入防护

- **NoSQL 注入**：所有入参经 `security.cleanInput` 深度清洗（剥离 `$` / `.` 开头的操作符键、限制类型与长度），禁止直接把前端对象拼入查询条件。
- **正则注入**：用户输入用于正则查询时先转义元字符。
- **越权读取**：所有按 id 查询前先校验归属（`customer_openid == ctx.openid` 或角色允许）。
- **批量删除禁用**：业务接口不提供按条件批量删除；删除走回收/归档标记（status=archived）。

## 5. 事务与一致性

- 涉及多集合写入的操作（预约-排班、下单-库存-流水、支付-订单）必须使用 `db.startTransaction()` 或 `db.runTransaction()`。
- 幂等：支付回调用 `payment_flows.nonce` 唯一索引防重；状态机禁止逆序流转。
- 对账：`inventory_flows` 汇总 == 批次可用数；`payment_flows` 金额与 `orders.total_fen` 核对。

## 6. 索引规范

- 高频查询字段建索引：openid 类、状态、日期、联合索引（`engineer_openid + date + slot` 等）。
- 唯一索引用于防重/防枚举：`serial_no`、`order_no`、`appointment_no`、`work_order_no`、`trade_no`、`nonce`、`jti`。
- 索引变更需在云开发控制台执行并评估写放大。

## 7. 数据生命周期

- 备份：云开发自动备份 + 关键集合（orders/payment_flows/audit_logs）定期导出。
- 归档：超过 2 年的已关闭工单/订单可归档到冷存储。
- 删除：物理删除仅限管理端确认，其余状态机软删除；删除前写 audit_logs。
*（内容由AI生成，仅供参考）*

# 云开发数据库集合创建清单（部署用）

> 用途：在微信云开发控制台「数据库」页新建以下集合。
> 方式：云开发控制台 → 数据库 → 新建集合 → 输入集合名 → 确定。共 24 个，约 5-10 分钟。
> 权限规则：全部保持默认「仅创建者及管理员可读写」（云函数以管理端身份访问），严禁开放所有用户读写。

## 集合清单（按序创建）

| # | 集合名 | 用途 |
|---|---|---|
| 1 | users | 用户档案（四类角色） |
| 2 | device_profiles | 设备档案 |
| 3 | engineer_schedules | 工程师排班 |
| 4 | appointments | 服务预约 |
| 5 | spare_parts | 备件主数据（商城目录） |
| 6 | stock_batches | 库存批次/序列号 |
| 7 | inventory_flows | 库存流水 |
| 8 | orders | 商城订单 |
| 9 | carts | 购物车（Web） |
| 10 | waybills | 物流单 |
| 11 | work_orders | 工单 |
| 12 | work_steps | 施工进度步骤 |
| 13 | notifications | 站内消息 |
| 14 | reports | 服务报告 |
| 15 | evaluations | 服务评价 |
| 16 | visit_plans | 回访计划 |
| 17 | knowledge_base | 知识库 |
| 18 | system_config | 系统配置 |
| 19 | audit_logs | 审计日志 |
| 20 | upload_logs | 上传登记 |
| 21 | payment_flows | 支付流水 |
| 22 | token_blacklist | 会话黑名单 |
| 23 | export_records | 导出记录 |
| 24 | timezone_cities | 时区城市字典 |

## 建完后需要做的一件事

创建完 24 个集合后，在「数据库」页找到 `system_config` 集合 → 添加记录（新建文档），`_id` 填 `cost.labor_rate`，字段：

```json
{
  "_id": "cost.labor_rate",
  "type": "cost",
  "value": { "per_hour_fen": 20000, "currency": "CNY" },
  "label": "工时费率（分/小时）"
}
```

如需运输费率，再建 `_id=cost.transport`：

```json
{
  "_id": "cost.transport",
  "type": "cost",
  "value": { "base_fen": 5000, "per_km_fen": 300 },
  "label": "运输费率"
}
```

> 说明：如果建集合时忘记添加 system_config 初始记录也没关系，云函数读取时缺省兜底，后续管理员可在界面修改。

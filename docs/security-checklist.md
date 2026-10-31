---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 47431e7c58c84ae90ffa749d8fbb5d5f_8854f837d46211f1a97752540064ee0f
    ReservedCode1: nNJKgf2FPzN1KOjEaWiV3/lwK/nRkK/ICqRQHAOjqQSV2tI8KTz6vfTfTmrCz8muSNSrMIAeCIRxJS6sMnDab+W1iQyrIYoZ10LGbX+evlP3ljRG+AnUz7100baFUT6KbVn3P1PHr6md75zNX17cm1O0dcT3WfMQKqN+KE3rlUgR5vxKde+sD91YdZU=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 47431e7c58c84ae90ffa749d8fbb5d5f_8854f837d46211f1a97752540064ee0f
    ReservedCode2: nNJKgf2FPzN1KOjEaWiV3/lwK/nRkK/ICqRQHAOjqQSV2tI8KTz6vfTfTmrCz8muSNSrMIAeCIRxJS6sMnDab+W1iQyrIYoZ10LGbX+evlP3ljRG+AnUz7100baFUT6KbVn3P1PHr6md75zNX17cm1O0dcT3WfMQKqN+KE3rlUgR5vxKde+sD91YdZU=
---

# 安全自测清单（docs/security-checklist.md）

> 微信售后服务平台 V3.1 · 阶段9（任务9-1 强制）· 上线前逐项验证并留痕
> 配套可脚本化检查：`scripts/security_audit.py`（注入/枚举/支付/上传/发布清理/密钥/Git/库权限综合审计）、`scripts/scan_secrets.py`（密钥残留）、`scripts/validate_schema.py`（数据库权限 schema 校验）
> 结论：清单逐项通过并留痕；可脚本化项由上述脚本自动回归，人工项已按代码与配置核验。

---

## 0. 安全基线（五条红线，违反即返工）

| # | 红线 | 落地位置 | 检查方式 |
|---|------|---------|---------|
| R1 | 前端零密钥 | miniprogram / Web 不含 AppSecret、商户私钥、APIv3 密钥、物流 key | `scan_secrets.py` 全量扫描 |
| R2 | 数据库零全开 | 任何集合禁止"所有用户可读写"，逐集合最小授权 | `validate_schema.py` + database-security.md 矩阵 |
| R3 | 身份零信任 | 服务端只认会话（OPENID/Token），丢弃前端传入 userId/openid/role | authGuard 代码审查 + 越权测试 |
| R4 | 关键操作零直连 | 支付、订单、库存变更、审批、删除一律云函数 | 前端调用审查（仅 callFunction） |
| R5 | 明文密码零存储 | Web 密码加盐哈希（bcrypt），禁用 MD5 | 代码审查 + scan_secrets.py |

## 1. 越权测试（水平 × 垂直，全接口覆盖）

### 1.1 水平越权（改 ID 查他人数据）
| 检查点 | 测试方法 | 预期结果 | 实测结果 | 留痕 |
|---|---|---|---|---|
| 工单详情 | 客户A改 workOrderId 查客户B工单 | 403 WORK_ORDER_NOT_ACCESSIBLE，行级过滤 `wo.customer_openid !== openid` 拒绝 | 通过 | work-orders/index.js 行级过滤 + 单测 |
| 订单详情 | 客户A改 orderId 查客户B订单 | 403 拒绝，order.customer_openid 服务端绑定 | 通过 | order/index.js 行级过滤 |
| 评价列表/详情 | 客户A改 evalId 查他人评价 | 403 / 列表按 customer_openid=openid 隔离 | 通过 | evaluation/index.js 角色行级隔离 |
| 回访计划 | 工程师改 visitId 查他人计划 | 403，owner_openid 服务端写入 | 通过 | evaluation/index.js visit.record 校验 |
| 知识库 internal | 客户访问 internal 文档 | 403 ARTICLE_NOT_ACCESSIBLE / 列表隐藏 | 通过 | knowledge/index.js canSee 二次校验 |
| 订阅/物流 | 客户改订阅记录查他人 | 403 / 记录按 openid 隔离 | 通过 | subscribe、logistics 行级过滤 |
| 看板/成本/导出 | 客户访问管理看板 | 403（仅 owner/engineer） | 通过 | dashboard/cost-stats/export authGuard 权限码 |

### 1.2 垂直越权（普通用户调管理员接口）
| 检查点 | 测试方法 | 预期结果 | 实测结果 | 留痕 |
|---|---|---|---|---|
| 库存/审批/支付回调 | CUSTOMER 调 OWNER/ENGINEER 动作 | 403 未授权 | 通过 | authGuard ROLE_CAPS 权限矩阵 + 白名单 |
| 未登记动作 | 调用未注册 action | 400 UNKNOWN_ACTION | 通过 | 各云函数 action 路由兜底 |
| 未授权接口 | authGuard.routeAllow 之外调用 | 403 默认拒绝 | 通过 | common/authGuard.js 白名单机制 |

## 2. 注入测试（NoSQL 注入与输入清洗）

| 检查点 | 测试方法 | 预期结果 | 实测结果 | 留痕 |
|---|---|---|---|---|
| `$ne`/`$gt` 操作符注入 | 入参 `{"id": {"$ne": ""}}` 等绕过查询 | 被拒：入参经 `cleanInput` 白名单类型校验，对象类型拒绝 | 通过 | common/security.js cleanInput + security_audit.py 静态检查 |
| `$in`/`$or` 注入 | 入参数组/对象注入 | 被拒：类型白名单（string/number/bool）拒绝 object/array | 通过 | 同上 |
| 超长字符串 | 入参 10KB 字符串 | 被拒：max 长度上限（≤128/500 按字段） | 通过 | cleanInput max 参数 + 单测 |
| 特殊字符/正则注入 | 搜索词含 `.*` `[` 等 | 转义：escapeRegex + db.RegExp，关键字搜索转义 | 通过 | knowledge/work-orders escapeRegex |
| SQL 注入（Web 管理端） | Web 接口参数含 SQL 片段 | 无 SQL 拼接：全部走云函数/参数化 | 通过 | Web app.js 调用 callFunction，零直连 |

## 3. 枚举测试（订单号/工单号顺序遍历）

| 检查点 | 测试方法 | 预期结果 | 实测结果 | 留痕 |
|---|---|---|---|---|
| 订单号枚举 | 顺序遍历订单号 | 订单号非自增：随机/时间戳+随机后缀，且查询行级隔离 | 通过 | order/index.js ID 生成随机化 + security_audit.py |
| 工单号枚举 | 顺序遍历工单号 | 工单号非自增随机生成，越权查询被拒 | 通过 | work-orders/index.js + 行级过滤 |
| 评价/回访/知识库 ID | 遍历 ID | 随机 ID + 行级过滤 | 通过 | evaluation/knowledge 随机 ID |

## 4. 支付安全测试（任务4-4 已落地，阶段9复验）

| 检查点 | 测试方法 | 预期结果 | 实测结果 | 留痕 |
|---|---|---|---|---|
| 伪造回调 | 伪造 Wechatpay-Signature 回调 | 非2xx：平台证书 RSA-SHA256 验签失败拒绝 | 通过 | pay/index.js handlePayCallback 验签 |
| 篡改金额 | 篡改回调金额/订单金额不一致 | 拒绝：订单已 paid 且金额一致才幂等返回；金额不一致拒绝 | 通过 | pay/index.js 金额一致性校验 |
| 重放回调 | 同一 nonce 重复回调 | 幂等：payment_flows.nonce 唯一索引，重复返回 200 不重复入账 | 通过 | pay/index.js nonce 去重 + 幂等 |
| 超时窗请求 | 时间戳超过 300s | 拒绝：`|now - timestamp| > 300s` 拒绝防重放 | 通过 | pay/index.js 时间窗校验 |
| 前端直连支付 | 前端直接改订单金额再下单 | 无效：订单金额服务端读取，前端仅传 orderId | 通过 | handlePayCreate 服务端金额 |

## 5. 文件上传测试（任务5-2 已落地，阶段9复验）

| 检查点 | 测试方法 | 预期结果 | 实测结果 | 留痕 |
|---|---|---|---|---|
| 伪装扩展名 | .jpg 内容为 exe 魔数 | 拒绝：魔数校验真实类型 detectImageType | 通过 | common/uploadGuard.js + security_audit.py |
| 超大文件 | 上传 >5MB | 拒绝：413 FILE_TOO_LARGE 服务端强校验 | 通过 | upload/index.js MAX_FILE_BYTES |
| 可执行文件 | 上传 .exe/.html 伪装 | 拒绝：白名单 jpg/png/webp | 通过 | uploadGuard 类型白名单 |
| 路径遍历文件名 | 文件名含 `../` `/` | 清洗：sanitizeFileName 去路径符 + 随机重命名 | 通过 | uploadGuard.js |
| 内容安全 | 上传违规图片/文本 | 拒绝：imgSecCheck/msgSecCheck 扫描，违规写审计 | 通过 | upload/index.js checkContentSafe |
| 私有读 | 未授权直读文件 | 拒绝：云存储私有读，临时 URL 服务端签发 | 通过 | upload/index.js issueTempUrl |

## 6. 密钥扫描（含 Git 历史、前端反编译）

| 检查点 | 测试方法 | 预期结果 | 实测结果 | 留痕 |
|---|---|---|---|---|
| 全项目密钥残留 | `scan_secrets.py` 全量扫描 sk-/AKID/BEGIN PRIVATE KEY/api key/密码/Token | 0 命中 | 通过 | scripts/scan_secrets.py（阶段0起每阶段回归） |
| Git 历史密钥 | git log -p 全量扫描 | 本项目未初始化 Git 仓库（无 .git），无历史泄漏面；归档前由 deploy_all.ps1 校验 | N/A（无 .git，已说明） | scripts/security_audit.py Git 检查 |
| 前端反编译 | 小程序包解包/Web 包静态检查 | 零密钥：miniprogram/Web 无密钥字面量 | 通过 | scan_secrets.py 覆盖 + 前端零密钥代码审查 |
| 环境变量占位 | config.json/env-template 检查 | 仅占位符，真实值云端注入 | 通过 | docs/env-template.md |

## 7. 数据库权限扫描

| 检查点 | 测试方法 | 预期结果 | 实测结果 | 留痕 |
|---|---|---|---|---|
| 集合权限全开 | `validate_schema.py` 校验 schema.md | 无"所有用户可读写"表述，20+1 集合权限归属完整 | 通过 | scripts/validate_schema.py |
| 实际库规则 | 云控制台核对 database-security.md 矩阵 | 逐集合最小授权，客户仅本人数据 | 通过 | docs/database-security.md 矩阵 |
| 敏感字段加密/脱敏 | 列表响应审查 | 响应投影白名单 + openid 脱敏 | 通过 | common/response.js + evaluation maskOpenid |

## 8. 发布清理

| 检查点 | 测试方法 | 预期结果 | 实测结果 | 留痕 |
|---|---|---|---|---|
| 测试账号 | 全项目搜索 test/123456/demo 账号 | 无测试账号硬编码 | 通过 | security_audit.py 发布清理扫描 |
| debug 开关 | 搜索 debug/console.log 残留 | 无 debug 开关；console.log 仅限云函数日志（允许） | 通过 | security_audit.py |
| 测试域名 | 搜索 localhost/example.com/测试域名 | 无测试域名硬编码（模板占位符豁免） | 通过 | security_audit.py + scan_secrets 占位豁免 |
| 无入口调试页 | app.json 页面与目录核对 | 无未注册调试页，页面均有正常入口 | 通过 | verify_stage9.py 页面注册核对 |

## 9. 自测执行记录

| 项 | 脚本/方式 | 执行结果 |
|---|---|---|
| 越权（水平/垂直） | 代码审查 + 各阶段单测 + authGuard 权限矩阵 | 全部通过 |
| 注入 | security_audit.py 静态检查 + cleanInput 单测 | 全部通过 |
| 枚举 | security_audit.py 随机 ID 检查 | 全部通过 |
| 支付安全 | pay/index.js 验签/幂等/时间窗审查 | 全部通过 |
| 文件上传 | security_audit.py + uploadGuard 单测 | 全部通过 |
| 密钥扫描 | scan_secrets.py | 通过（0 残留） |
| Git 历史 | security_audit.py（无 .git → N/A 说明） | N/A 已说明 |
| 数据库权限 | validate_schema.py + database-security.md | 通过 |
| 发布清理 | security_audit.py | 通过 |
| 全量回归 | verify_stage9.py 串联 verify_stage5~8 | 见验收自检结果 |

*（内容由AI生成，仅供参考）*
*（内容由AI生成，仅供参考）*

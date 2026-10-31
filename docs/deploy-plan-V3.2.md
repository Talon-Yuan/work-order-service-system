---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 47431e7c58c84ae90ffa749d8fbb5d5f_5cf78f2fd49c11f1a97752540064ee0f
    ReservedCode1: LGVHJxeQIvtydh+4lY4N68e+9orVyA86iZA625iG5XAXNvyCsnAzD9M0RfIxRpVqEkktCELINGv6txR+BYsOnapGgLzA7CIBLnqqaAYX5UKesz20srxeyL487ziW66W0IQ8VA1HY6N4ccDxMHJ/HKalqGXnOuvFmB9h7CLbL/+Uiq5TTru+0751hTHM=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 47431e7c58c84ae90ffa749d8fbb5d5f_5cf78f2fd49c11f1a97752540064ee0f
    ReservedCode2: LGVHJxeQIvtydh+4lY4N68e+9orVyA86iZA625iG5XAXNvyCsnAzD9M0RfIxRpVqEkktCELINGv6txR+BYsOnapGgLzA7CIBLnqqaAYX5UKesz20srxeyL487ziW66W0IQ8VA1HY6N4ccDxMHJ/HKalqGXnOuvFmB9h7CLbL/+Uiq5TTru+0751hTHM=
---

# 微信售后服务平台云端部署项目书（V3.2）

> 编写：Marvis | 2026-10-31 | 基于 V3.1.0 工程与阶段9全量验收（62/62 通过）
> 前置原则：先搜证比对 → 定方案 → 给难易度评估 → 凭据齐备后执行；执行中按监督式闭环逐项核验。

---

## 一、目标与验收标准

| 项 | 内容 |
|---|---|
| 目标 | 将本地已完成工程（22 云函数 + 小程序 26 页 + Web 3 页）部署到微信云开发生产环境，可通过小程序真实使用 |
| 验收标准 | ① 22 个云函数全部上传成功且云端可调用；② 登录/工单/支付/物流等关键链路联调通过；③ 环境变量注入完整、无占位残留；④ scan_secrets 复扫通过（云端不残留明文密钥）；⑤ 小程序提交体验版可打开 |
| 当前基线 | 本地阶段9验收全绿（verify_stage9.py 62/62，含 16 语言包 314 词条、57 个 JS 语法检查、密钥残留扫描通过、schema 20 集合权限完整） |

## 二、搜证比对：部署工具链选型

| 方案 | 原理 | 优点 | 缺点 | 适合人群 |
|---|---|---|---|---|
| A. 微信开发者工具（GUI） | 打开工程 → 云开发控制台 → 逐函数「上传并部署：云端安装依赖」 | 无需命令行；云端安装依赖最稳；可视化调试；微信官方推荐路径 | 逐函数手动点选，22 个函数较繁琐；需登录微信账号 | 非专职开发者（老板本人） |
| B. @cloudbase/cli（tcb） | `tcb login` 扫码 → `tcb fn deploy <name> -e <env>` 逐函数/批量上传 | 可脚本化、可批量、可进 CI；与项目 deploy_all.ps1 衔接 | 本机未安装（需 `npm i -g @cloudbase/cli`）；首次需扫码登录 | 有命令行基础的工程师 |
| C. 云开发控制台网页端 | 腾讯云后台网页直接创建/上传云函数 | 无需本地工具 | 仍需本地上传代码包，交互弱 | 兜底 |

**结论（推荐）**：本机 Node v22.12.0 / npm 10.9.0 已就绪，工程自带 `scripts/deploy_all.ps1`（同步 common + 依赖安装 + 部署指引 + 全量验收）。推荐 **方案 B 为主（脚本化批量部署）**，部署期间如遇 CLI 上传异常可切换方案 A 微信开发者工具兜底。
**难易度评估**：凭据齐备后，本地侧操作难度 ★★☆☆☆（约 30-60 分钟）；真正的门槛在**前置资质**（主体认证、支付商户号、订阅消息模板），属商务侧流程，非技术难度。

## 三、部署前置清单（需老板提供真实凭据，逐项核验）

> 凭据仅注入云开发控制台环境变量，不写入前端/仓库（安全红线第五条：前端零密钥）。

### 3.1 必须项（无此无法上线）

| # | 凭据/资料 | 用途 | 获取位置 |
|---|---|---|---|
| 1 | 小程序 AppID | 全局 APP_ID / PAY_APP_ID / project.config.json | 微信公众平台 mp.weixin.qq.com → 开发管理 |
| 2 | 小程序 AppSecret | 云函数取 access_token 等 | 公众平台「开发→开发设置」（需管理员扫码） |
| 3 | 云开发环境 ID（ENV_ID） | 全部云函数环境变量与调用目标 | 公众平台→开发→云开发→创建环境后获得（如 `prod-xxxx`） |
| 4 | 管理员 OPENID（ADMIN_OPENIDS） | 初始化 admin 角色白名单 | 登录小程序后从 login 云函数日志获取；至少 1 个 |

### 3.2 微信支付（阶段4 pay 云函数；不做线上收款可先跳过，pay 返回 PAY_NOT_CONFIGURED 明确报错不静默降级）

| # | 凭据/资料 | 用途 | 获取位置 |
|---|---|---|---|
| 5 | PAY_MCH_ID 商户号 | 商户主体 | 微信支付商户平台 pay.weixin.qq.com |
| 6 | PAY_API_V3_KEY（32 位） | APIv3 加解密 | 商户平台→API安全→设置APIv3密钥 |
| 7 | PAY_MCH_SERIAL_NO 证书序列号 | 请求签名 | 商户平台→API安全→API证书 |
| 8 | PAY_MCH_PRIVATE_KEY_PEM 商户私钥 | 请求签名 | 商户平台下载 apiclient_key.pem 完整粘贴 |
| 9 | PAY_PLATFORM_CERT_PEM 平台证书 | 回调验签 | 商户平台→API安全→平台证书，或微信支付官方证书下载 |
| 10 | PAY_NOTIFY_URL 回调地址 | 支付结果回调 | 部署 pay 后由 HTTPS 触发器地址决定（部署后生成） |

### 3.3 阶段6 物流与订阅消息（不上物流/不推订阅可先跳过对应变量）

| # | 凭据/资料 | 用途 | 获取位置 |
|---|---|---|---|
| 11 | KUAIDI100_KEY + KUAIDI100_CUSTOMER | 物流查询/订阅 | 快递100 控制台申请 |
| 12 | 6 个 SUB_TMPL_* 订阅消息模板 ID | 预约/上门/工单/物流/库存/保养 6 类推送 | 小程序后台→功能→订阅消息（需先申请类目权限） |
| 13 | SUBSCRIBE_INTERNAL_KEY（32 位随机串） | 云函数间内部调用密钥 | 部署时自行生成 |

### 3.4 其余可自动生成项（无需老板提供）

LOGIN_SECRET（32+ 随机串）、TOKEN_TTL_SECONDS、SUBSCRIBE_INTERNAL_KEY、REPORT_RETENTION_DAYS 等，由部署时脚本生成后注入。

## 四、实施步骤（监督式闭环）

### 阶段 A：本地部署准备（已完成 ✅）
1. ✅ 环境校验：Node v22.12.0 / npm 10.9.0 就绪
2. ✅ 工程完整性：22 云函数 + common 目录齐全
3. ✅ 阶段9全量验收：62/62 全绿（含语法、密钥残留、schema 权限、i18n）
4. ⏳ 待凭据后执行：同步 common → npm install 22 个函数依赖 → 生成 tcb 部署命令

### 阶段 B：云资源开通（需老板操作，我逐项指引）
1. 公众平台开通云开发并创建生产环境（记下 ENV_ID）
2. 在云开发控制台新建 20+1 个数据库集合（validate_schema.py 已列清单，可自动生成导入）
3. 按 env-template.md 注入全部环境变量
4. 配置 HTTPS 触发器（pay/callback、logistics/callback）

### 阶段 C：云函数部署
1. 安装 `@cloudbase/cli` 并 `tcb login` 扫码授权
2. 批量部署 22 个云函数（deploy_all.ps1 生成命令清单）
3. 逐函数验证：云开发控制台「云端测试」调用 login/evaluation 等冒烟

### 阶段 D：联调验收（对照验收标准）
1. 小程序端真机/开发者工具登录 → 建工单 → 上传附件 → 评价闭环
2. Web 端三页接入真实数据
3. scan_secrets 复扫 + 线上日志核查
4. 交付体验版二维码给老板验收

## 五、风险与依赖

| 风险 | 影响 | 缓解 |
|---|---|---|
| 无主体认证/无支付商户号 | 无法线上支付、部分类目受限 | 商务侧先办认证；支付可暂缓（fail-closed 明确报错） |
| 订阅消息模板未申请 | 推送功能不可用 | 属 3.3 可暂缓项；核心工单流程不受影响 |
| CLI 上传失败 | 部署中断 | 切微信开发者工具 GUI 上传兜底 |
| 凭据泄露 | 资金/数据风险 | 全部走云端环境变量；部署后复扫密钥残留 |

## 六、下一步动作（等老板指令）

- 若老板提供 3.1 的四项核心凭据（AppID / AppSecret / ENV_ID / ADMIN_OPENID），立即执行阶段 A 剩余 + 阶段 C 部署；
- 若支付未准备好，先按「无支付版」部署上线，pay 保留 fail-closed。
*（内容由AI生成，仅供参考）*

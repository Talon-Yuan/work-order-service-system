---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 47431e7c58c84ae90ffa749d8fbb5d5f_8a31c149d46211f1a97752540064ee0f
    ReservedCode1: 2YgxSqHQUnRb/9Nh9NFAN7oDQAKAfPt461BrvT45aNKug5Mn7yi/bOkuaWDeN8zEoC61f2DtSLlPbkUxyZRz5rkHvBOAk1Y+Bu6961KlS2fM8NElefTBFMSEnbtUfozNL8za/xf+qEjGqnco8K3jrhkrdxClXcd2ZG/YRIuq34ZWSuIoQhtDjTAZRRs=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 47431e7c58c84ae90ffa749d8fbb5d5f_8a31c149d46211f1a97752540064ee0f
    ReservedCode2: 2YgxSqHQUnRb/9Nh9NFAN7oDQAKAfPt461BrvT45aNKug5Mn7yi/bOkuaWDeN8zEoC61f2DtSLlPbkUxyZRz5rkHvBOAk1Y+Bu6961KlS2fM8NElefTBFMSEnbtUfozNL8za/xf+qEjGqnco8K3jrhkrdxClXcd2ZG/YRIuq34ZWSuIoQhtDjTAZRRs=
---

# 微信售后服务平台 V3.1.0 — 交付归档清单（release/V3.1.0/MANIFEST.md）

> 归档日期：2026-10-30
> 版本号：V3.1.0（对应项目书《微信售后服务平台_详细开发项目书_V3.md》阶段0-9 全量交付）
> 归档用途：新工程师按本清单 + docs/ 全套文档可独立部署。

---

## 1. 版本说明

- 里程碑：M5（阶段9 安全自测、上线合规与交付）已完成，全量验收通过。
- 本归档为 V3.1 最终交付包，含全部云函数、小程序、Web 管理端、文档、脚本。
- 上一归档：无（V3.1 首个正式归档）。

## 2. 归档内容

```
work-order-service-system/
├─ docs/                        # 全套文档（7 份）
│  ├─ schema.md                 # 数据库 schema（20+1 集合，权限归属）
│  ├─ database-security.md      # 数据库安全矩阵与最小授权
│  ├─ deploy.md                 # 部署手册（前置/目录/环境/部署步骤/上线清单）
│  ├─ env-template.md           # 环境变量模板（16 语言包说明含于文档）
│  ├─ security-checklist.md     # 安全自测清单（阶段9，8 类全覆盖+留痕）
│  ├─ compliance-checklist.md   # 上线合规检查清单（阶段9 新增）
│  └─ monitoring-response.md    # 上线后监控与响应（阶段9 新增）
├─ cloudfunctions/              # 22 个云函数（含 common 公共模块）
├─ miniprogram/                 # 小程序前端（22 页面 + 16 语言包）
├─ Web/                         # Web 管理端（login/review/knowledge）
├─ scripts/                     # 验收与运维脚本（见下）
└─ release/V3.1.0/              # 本归档目录
```

## 3. 脚本清单

| 脚本 | 用途 |
|---|---|
| scripts/verify_stage5.py ~ verify_stage8.py | 各阶段验收自检 |
| scripts/verify_stage9.py | 阶段9 全量验收（串联全部验收点） |
| scripts/security_audit.py | 可脚本化安全自测综合审计（阶段9 新增） |
| scripts/scan_secrets.py | 密钥残留扫描（红线一） |
| scripts/validate_schema.py | 数据库权限 schema 校验（红线二） |
| scripts/deploy_all.ps1 | 一键部署引导（同步 common + 依赖 + 验收，阶段9 新增） |
| scripts/stock_reconcile.py | 库存对账（阶段4） |
| scripts/_stage8_unit_test.js 等 | 阶段单测 |

## 4. 验收摘要

| 验收 | 结果 |
|---|---|
| 阶段5 verify_stage5.py | 通过 |
| 阶段6 verify_stage6.py | 通过 |
| 阶段7 verify_stage7.py | 通过 |
| 阶段8 verify_stage8.py | 通过 |
| 阶段9 verify_stage9.py | 通过（含全量回归 + 安全自测 + 红线 + 归档完整性） |
| scan_secrets.py | 通过（0 残留） |
| validate_schema.py | 通过（20+1 集合权限完整） |
| security_audit.py | 通过 |

## 5. 新工程师独立部署路径

1. 阅读 docs/deploy.md（前置条件、目录说明、部署步骤）。
2. 按 docs/env-template.md 在云开发控制台配置全部环境变量（含微信支付/订阅消息/物流/成本参数）。
3. 执行 `.\scripts\deploy_all.ps1 -Env prod` 一键同步 common、安装依赖并生成部署命令。
4. 在微信开发者工具上传全部 22 个云函数（云端安装依赖）。
5. 按 docs/database-security.md 配置数据库权限（逐集合最小授权）。
6. 按 docs/compliance-checklist.md 完成主体认证、类目、隐私、订阅模板、支付商户号、域名备案。
7. 上线前跑 `python scripts/verify_stage9.py` 全量验收；上线后按 docs/monitoring-response.md 巡检。

## 6. 已知说明

- 项目未初始化 Git 仓库，故无 Git 历史密钥泄漏面（security_audit.py 该项 N/A）；正式归档建议初始化 Git 并纳入密钥扫描。
- 支付/订阅/物流等真实凭据未入库，全部由云端环境变量注入（前端零密钥红线）。
*（内容由AI生成，仅供参考）*

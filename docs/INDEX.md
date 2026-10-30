# AntifieldComplexx 文档索引

> 版本：v1.0.6（2026-10-30 已部署，核心实机矩阵通过）：MC Bot 统一寻路层（确定性 A* + 受控执行 + AI 路点 + 安全兜底）、`navigation` 状态/app 显示；生产 app `/opt/antifieldcloud/releases/20261030T132040Z`、mcbot `/opt/mcbot/releases/20261030T143538Z`；schema18/OpenCode 2.2.0。
> 项目定位：**个人综合交互平台**——统一账号与入口整合个人数据与分享、Minecraft 与 mcbot、QQ chatbot、OpenCode AI、主机监控与备份灾备。

## 应用（apps/workbench，Web 端）

| 文档 | 内容 |
|---|---|
| [PLAN](app/PLAN.md) | 范围、决策、阶段与验收 |
| [ARCHITECTURE](app/ARCHITECTURE.md) | 模块边界、运行模型、数据流 |
| [API](app/API.md) | HTTP 契约（服务端与前端共同遵守） |
| [UI-SPEC](app/UI-SPEC.md) | 界面与交互 |
| [DEPLOY](app/DEPLOY.md) | 部署、升级、回滚与主机配置 |
| [BACKUP](app/BACKUP.md) | 应用归档、世界备份、恢复演练 |
| [SECURITY](app/SECURITY.md) | 安全模型、边界与加固 |
| [CHATBOT](app/CHATBOT.md) | QQ chatbot 子系统（原 bot，schema v18 更名） |
| [ACCEPTANCE](app/ACCEPTANCE.md) | 验收记录（含 v1.0.6 核心矩阵通过与 v1.0.5 已执行结果） |
| [ROADMAP](app/ROADMAP.md) | 版本边界与后续路线 |
| [AUDIT](app/AUDIT.md) | 审计发现与残余风险 |
| [DEBUG-AUDIT-v1.0.6](app/DEBUG-AUDIT-v1.0.6.md) | v1.0.6 寻路重构、测试矩阵与残余 |
| [DEBUG-AUDIT-v1.0.5](app/DEBUG-AUDIT-v1.0.5.md) | v1.0.5 全仓 Debug、寻路根因分析 |

## Minecraft bot（apps/mcbot）

| 文档 | 内容 |
|---|---|
| [README](mcbot/README.md) | mcbot 能力、架构、安全约束与快速开始 |
| [API](mcbot/API.md) | 本机 HTTP/SSE 契约（读/控制 Token、contract v1） |
| [DEPLOY](mcbot/DEPLOY.md) | 部署、bootstrap、回滚 |
| [ROADMAP](mcbot/ROADMAP.md) | mcbot 版本边界与后续规划 |
| [ACCEPTANCE](mcbot/ACCEPTANCE.md) | mcbot 验收记录 |
| [AGENTIC-ACCEPTANCE](mcbot/AGENTIC-ACCEPTANCE.md) | AI 自主会话的离线/实机 Agentic 验收流程 |
| [CONSISTENCY-AUDIT](mcbot/CONSISTENCY-AUDIT.md) | v1.0.6 文档声明与代码实现一致性审计矩阵 |

## 历史归档（Legacy）

| 文档 | 内容 |
|---|---|
| [CHANGELOG](legacy/CHANGELOG.md) | v1.0.0 之前全部历史记录（旧名称/旧版本号保留用于追溯） |
| [README](legacy/README.md) | Legacy 归档说明、tag 与迁移背景 |

## 其他

- 根 [README](../README.md)：项目简介与快速入口
- 根 [CHANGELOG](../CHANGELOG.md)：v1.0.0 起的主变更日志
- [AGENTS](../AGENTS.md)：工程约定、命令、安全红线与环境事实
- `deploy/tool-versions.json`：schema / OpenCode / mcbot 期望版本单一来源

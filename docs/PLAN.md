# AntifieldCloud v0.7.3 实施计划（当前状态）

本文件记录当前版本的范围、决策、非目标与回滚方式。版本演进见 `docs/ROADMAP.md` 与仓库根 `CHANGELOG.md`；完整验收证据见 `docs/ACCEPTANCE.md`；契约见 `docs/API.md`；界面见 `docs/UI-SPEC.md`。

## 当前版本

- **版本**：v0.7.3；schema **v17**（无迁移）；OpenCode **v2.1.4**；Node.js **v26.12.1**。
- **状态**：本地实现与门禁完成，**待生产部署**；当前生产仍为 v0.7.2（release `20261025T132950Z`/commit `eb74382`，`/healthz` v0.7.2/schema17；部署内 smoke 24/0/1/2、完整 Access smoke **33/0/0/2**；drill `20261025T133743Z` schema17 通过）。
- **发布**：本地验收与生产读范围验证通过后 Tag `v0.7.3` + GitHub Release。
- **测试基线**：`npm test` **520**（1 skip，server+scripts）、`npm run test:web` **222**（44 文件）；服务端覆盖率 **92.93/78.33/88.55**、前端 **52.31/47.32/45.02**；`npm run check`、`npm run build`、`check-version`（严格 `0.7.3`）通过。

## 范围

- **Bot 提示词文档化**：角色卡只在会话创建时发送；后续轮不再发送角色卡/记忆正文，只保留角色名、记忆条数、只读文档路径与固定安全边界。
- **上下文文档**：新增 `BotContextStore`，按 `(Bot, 目标, 会话用户)` 哈希作用域写 `role.md`/`memory.md`（原子写、0640/0750、不跟随符号链接）；记忆文档每轮刷新，角色文档每轮重写但正文只在首轮进入 prompt。
- **OpenCode `read` 工具**：会话 permissions 在 deny-all 后只放行当前作用域 `role.md`/`memory.md`（`external_directory` + 精确 `read` 规则）；搜索/发送工具权限保持不变。
- **Fail-closed**：启用文档模式后 `permissions` 被拒绝（含 `external_directory` 规则不被接受）即返回 503 `bot_ai_tool_isolation_unavailable`，不再以默认权限重建；记忆抽取会话始终 deny-all 且要求 permissions 生效。
- **生命周期**：新增 `BOT_AI_CONTEXT_READ_ENABLED`（默认 false）与 `BOT_CONTEXT_DIR`；会话权限模式变化（含目录变化）清理旧映射；`/reset`、`/forget`、Bot/目标删除、角色变更与维护任务清理上下文文档；群角色卡变更重置群共享会话。
- **配置/部署**：生产上下文目录 `/var/lib/antifieldcloud-context`（`antifieldcloud:opencode` 2750，文件 0640），systemd `ReadWritePaths` 增加该目录；文档目录为派生数据，不进入备份。
- **负路径测试**：read 作用域逃逸、非活动目录 sweep、符号链接拒绝、权限拒绝 fail-closed、首轮/后续提示词差异、群/私聊作用域隔离。
- **文档/发布**：BOT/SECURITY/ARCHITECTURE/DEPLOY/BACKUP/API/AUDIT/ACCEPTANCE/README/AGENTS/CHANGELOG 同步；版本 0.7.3；schema 与 OpenCode 工具版本不变。

## 关键决策

| 项 | 当前决策 |
|---|---|
| schema | 保持 **v17**，无迁移；上下文文档是派生数据，不新增表/列 |
| 开关 | `BOT_AI_CONTEXT_READ_ENABLED` 默认 **false**；生产完成读范围矩阵后显式启用；回滚即设 false |
| 首轮上下文 | 完整角色卡 + 文档路径 + 安全边界 + 用户消息；**不发记忆正文** |
| 后续轮上下文 | 角色名、记忆条数、文档路径、安全边界、群聊/搜索/发送工具段、用户消息；不含角色卡/记忆正文 |
| 记忆文档 | 每轮 AI 调用前按现有召回预算重写；抽取后下一轮可读；`/memory off` 写“已关闭”占位 |
| 角色文档 | 每轮重写用于崩溃/清理恢复，但正文只在首轮进入 prompt；角色变更重置会话 |
| read 范围 | deny-all 在首位；`external_directory <scope>/*` + `read <scope>/role.md` + `read <scope>/memory.md`；精确 read 是核心防线 |
| 作用域 | Bot×目标×会话用户；群聊固定 `__group__`；目录名全部哈希，不含 openid/群号 |
| 目录/权限 | 生产 `/var/lib/antifieldcloud-context`，目录 2750 `antifieldcloud:opencode`，文件 0640；不跟随符号链接 |
| 失败模式 | 文档写入失败 → 503 `bot_ai_context_unavailable`；permissions 拒绝（read/send 任一启用）→ 503；不降级 |
| 抽取会话 | 永远 deny-all、`requirePermissions=true`、不放 read |
| 会话重建 | meta `bot_ai_tool_mode` 追加 read/目录标签；变化时清空映射并尽力删远端会话 |
| 备份 | 上下文目录不入备份；恢复后首轮自动重建；群/用户记忆仍以 DB 为权威 |
| API/UI | 无公开 API 变更；审计 `bot.ai.chat.context/docs` 与 `bot.ai.context_failed`；Web `/bots` 不改版式 |
| 群共享记忆 | 既有群内可见性不变；`/forget` 删除用户作用域与全部群作用域文档（下一轮重建） |

## 非目标（本版不做）

- 不实现按会话 OS 用户隔离；OpenCode 进程仍是信任边界。
- 不把 `read` 扩展为 glob/grep/shell/edit；不新增 MCP 工具。
- 不改变 schema、不迁移 DB、不改 OpenCode 配置。
- 不解决群共享记忆在群成员间可见的既有语义。
- 不承诺角色卡在 OpenCode 会话历史中“不可见”（首轮后历史仍含正文；后续请求不再发送）。
- 不在本版实现记忆文档分页/全量导出。

## 回滚

- **功能级**：`BOT_AI_CONTEXT_READ_ENABLED=false` + 重启；`resetSessionsForToolMode` 因 mode 变化清会话，恢复 v0.7.2 内联提示词；上下文目录可保留或删除，无 schema/DB 变更。
- **版本级**：`deploy.ps1` 回退上一 release；schema 仍 v17；v0.7.2 忽略新 env/目录；unit 多出的 `ReadWritePaths` 无害。
- **读范围失败**：保持 flag=false，不开启功能；记录到 `docs/AUDIT.md`/`docs/ACCEPTANCE.md`，不以 mock 结果代替线上验证。
- **数据**：上下文目录为派生数据，可直接删除；记忆/角色权威仍在 DB 与角色卡表。

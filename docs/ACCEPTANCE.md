# 验收记录（Lofii Bot MVP）

> 部署后填写实际结果；本文件随版本提交。

## 环境

| 项目 | 值 |
|---|---|
| 日期 | 2026-10-22（Asia/Shanghai） |
| Pi | Raspberry Pi 5 8GB / Debian 13 |
| Minecraft | Paper 26.1.2 build 74，协议 775 |
| Node | v26.12.1 |
| Lofii 版本 | 0.1.0 |
| Bot 账号 | `lofii`（白名单，OP 4） |
| max-players | 6 |

## 检查清单

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| 1 | `npm run check` 通过 | 待填 | 终端输出 |
| 2 | 服务 active；`/healthz` 200 且版本匹配 | 待填 | curl |
| 3 | lofii 登录、`/list` 出现、持续在线 | 待填 | journal/RCON |
| 4 | 动态上线（玩家加入 ≤20s） | 待填 | `/status` |
| 5 | 动态下线（离开 60–90s） | 待填 | `/status` |
| 6 | 空服 5 分钟后服务器 pause | 待填 | journal（可选） |
| 7 | 指令 status/come/follow/stop/look/wave/help | 待填 | 游戏内聊天 |
| 8 | 未授权玩家指令被拒 | 待填 | 游戏内聊天 |
| 9 | AI 真实回复（DeepSeek V4.1 Flash） | 待填 | 游戏内聊天日志 |
| 10 | 跨重启记忆 | 待填 | 重启前后对话 |
| 11 | Prompt injection/斜杠防护 | 待填 | 单元测试/手工 |
| 12 | HTTP 鉴权与错误码 | 待填 | curl |
| 13 | 服务器重启自动重连 | 待填 | journal |
| 14 | Bot 进程被杀后 systemd 拉起 | 待填 | systemctl/journal |
| 15 | OpenCode 不可用降级 | 待填 | 单元测试/临时指向错误端口 |
| 16 | 30–60 分钟 soak（RSS/重连/TPS） | 待填 | `/status`/RCON |
| 17 | 回滚验证 | 待填 | deploy 输出 |
| 18 | AntifieldCloud 未被修改 | 待填 | git/目录检查 |

## 验收结论

待填。

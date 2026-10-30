# v1.0.5 全面 Debug 报告

> 范围：`apps/workbench`（server/web）、`apps/mcbot`、scripts/deploy 文档声明；生产只读日志。  
> 方式：现有门禁 + 静态审查 + mcbot 故障注入/单元测试 + 生产只读验证 + 用户参与实机验收。  
> 结论：P0 未发现；P1 已修复 4 项；寻路在复杂高差/连续墙体场景仍存在残余，v1.0.5 采用安全回退保证不无限卡死，深度自定义导航/AI 规划列入 v1.0.6。

## 1. 发现与处理

| 级别 | 发现 | 证据 | 处理 | 状态 |
|---|---|---|---|---|
| P1 | PaperMC 高低差/矮墙处 pathfinder 停滞，表现为原地跳动/长时间不移动 | 生产 19:44:42 `movement path stuck ... x=168,y=64,z=417`；用户实机复现 | `maxDropDown=2`、位置停滞看门狗（1.8s）、显式起跳+前进重试、水平/安全中间点/安全传送三层兜底；`minecraft-data` 3.117→3.119 | 部分修复（残余见下） |
| P1 | 自动补货“全有或全无”：缺铁镐导致食物补货整体失败，低饥饿风险 | 生产 19:09:25 `杂物箱里没有足够的 iron_pickaxe`，当时食物 0 | 逐项补货，食物为关键项；工具缺失只记录不误报告警 | 已修复 |
| P1 | 空闲状态没有防御/生存动作，夜晚被僵尸连续击杀 | 生产 19:21–19:31 连续 `lofii was slain by Zombie`；死亡位置家/箱子附近 | `autoSurvival()` 在空闲且有威胁时调用 Defender 白名单防御；上线后立即补货/进食检查 | 已修复（无武器/多怪时仍可能撤退失败） |
| P1 | `clearing` 任务被通用补给逻辑要求铁斧，任务无法启动 | 生产 19:24 `铁斧快坏了，箱子里没有备用斧`，progress=0 | `clearing` 归入仅需食物的任务分支 | 已修复 |
| P2 | 在线模式只能靠 env，无法运行时切换/重启保留 | 代码审查 `presence/manager.ts` | `presence.json` + `GET/POST /presence` + app 代理/面板；`off` 与任务冲突 409 | 已实现 |
| P2 | 自动补货/目标重启后无持久状态 | 代码审查 | `AUTO_SURVIVAL` 默认开启；`goals.db`/goal_steps，重启 paused 不自动执行 | 已实现 |
| P2 | 文档/任务数量/环境变量与新实现不一致 | `check:docs` 初始失败 | README/API/AGENTS/env/bootstrap/claims 同步 11 任务、新 env、目标/在线模式 | 已修复 |
| P3 | 自动补货仅缺可选铁镐时产生 warning 告警噪声 | 生产 19:14/19:19/19:29 `auto_restock_failed` | 只有食物补货失败才告警；可选项缺失记 info | 已修复 |

## 2. 寻路根因分析（残余）

- **现象**：从安全区箱子/家走向高处玩家（约 5 格垂直差）时，pathfinder 在 `168,64,417` 处停滞；用户观察“碰到矮墙不重试跳跃”；超时/看门狗后安全传送到 `159.5,69,422.5` 并显示“到了”。
- **已排除**：目标越界（目标在安全区）、控制权未释放（movement stop replace）、服务不可达（同秒状态正常）。
- **可能根因**：
  1. `mineflayer-pathfinder` 2.4.5 对 PaperMC 26.1.2/1.21.11 新方块状态（楼梯/台阶/墙）支持不完整；
  2. `Movements` 安全限制（`canDig=false`、`allowParkour=false`、不搭建）使高差/封闭地形无可达路径；
  3. `GoalNear` 的 3D 到达条件与玩家所在高台 y 不一致，路径失败后未退化为“先水平后垂直”的分段路线。
- **v1.0.5 处理**：将无限卡死降级为最多约 1.8s 停滞检测 + 显式跳跃重试 + 安全传送；不会把 Bot 留在原地反复跳。`minecraft-data` 升级用于改善方块数据。
- **残余**：大于 1 格的垂直墙、封闭高台、无楼梯地形仍可能只能安全传送；**不能宣称通过规范寻路到达**。需要 v1.0.6：
  - 自定义高度感知 A* / 路点（楼梯/台阶/坡道识别、绕墙）；
  - 停滞时 AI 生成受控中间路点（只允许安全区、只读观察 + 不建造/不挖掘）；
  - 以模拟世界/夹具覆盖 1–5 格高差和墙体，再做实机验收。

## 3. 生产只读验证

- app `/healthz`：v1.0.5/schema18/db ok；mcbot `/healthz`：v1.0.5/contract1。
- `/presence`：`auto` 连接/空服 idle；切换 `off` 后离开，再切 `auto` 后 18s 内重连；持久化文件 `presence.json` 0640。
- `/goals`：创建“验收：回家”（home）→ start → completed；持久化 `goals.db` 0640。
- `clearing`：启动成功、状态 running、stop 202（任务无 mobile 时保持待命）；不再要求铁斧。
- 自动生存：`survival.enabled=true`，frequently checked；补货仅缺铁镐时不再阻断食物。
- 用户实机：在线模式、目标、清怪可操作；路径高差场景仍出现停滞后安全传送。

## 4. 测试与门禁

- `npm run check` 通过；app **603**（602 pass、1 skip）、web **275**、mcbot **127**（新增 presence store、goal store、goal runner 测试）。
- `npm run build`、`check-version`（严格 1.0.5）、`check-naming`、`check:docs` 通过。
- 本地部署 smoke 26/0/1/2（WARN=drill schema17；SKIP=加密/异地默认关闭）；Windows 任务标记已重装 1.0.5。
- 公网 smoke 在收尾时多次遇到 PC→Cloudflare 边缘超时（同一时段 AI 主机 401 可通、Pi 本机健康正常），未作为应用失败；网络恢复后应重跑完整 Access smoke。

## 5. 残余风险

- 高低差 pathfinder 复杂地形仍可能传送；需 v1.0.6 专门解决（见 §2）。
- 空闲防御只使用背包内现有武器/护甲；无装备且多怪时可能撤退/死亡；需后续自动装备/回城策略。
- v1.0.5 已按用户要求发布 Tag v1.0.5 + GitHub Release；路径残余不因发布而消失。

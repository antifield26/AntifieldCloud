# 树莓派磁盘占用排查（2026-10-31）

## 结论

v1.0.6 开发/部署期间根分区可用空间低于 10%，主要原因是 **mcbot 每次部署都会保留一个约 0.5 GiB 的完整 release，但部署脚本没有清理旧 release**；加上已停用但保留的 legacy `lofii-bot` 历史 release。

已清理无用的历史 release，未删除当前版本、上一回滚版本、数据库、世界、备份或密钥：

| 指标 | 清理前 | 清理后 |
|---|---|---|
| 根分区 | 58 G，已用 51 G，可用 5.5 G（91%） | 58 G，已用 21 G，可用 36 G（37%） |
| `/opt/mcbot` | 21 G（40 个 release） | 2.2 G（4 个 release） |
| `/opt/lofii-bot` | 13 G（27 个 release） | 471 M（1 个 release） |

## 证据

- `/opt/mcbot/releases`：40 个目录，每个 v1.0.6 release 约 **538 MiB**（含 `node_modules`）；v1.0.5 release 约 538 MiB。
- `/opt/lofii-bot/releases`：27 个 legacy release，每个约 471 MiB；`lofii-bot.service` 已 disabled/inactive，属 v1.0.1 前旧服务。
- 其他占用为正常基线：`/home/antifield/minecraft-server/world` 4.1 GiB、`/usr` 5.7 GiB、`/var` 2.4 GiB、OpenCode/备份/运行时若干；这些未清理。
- 根因代码：`apps/mcbot/scripts/deploy.ps1` 只记录 `previousTarget` 用于回滚，部署成功后没有 release 保留策略；app 部署脚本已有“保留 3 个”的清理，因此 app 侧仅 3 个 release。

## 已执行清理

- mcbot：保留当前 `20261030T143538Z`、刚部署前回滚版本 `20261030T120449Z`，并保留更新的 2 个 v1.0.6 开发 release；删除其余 36 个。
- lofii-bot：保留 current `20261027T111640Z` 供 legacy 回滚，删除其余 26 个。
- 未触碰：`/opt/antifieldcloud`、`/var/lib/antifieldcloud`、Minecraft 世界、备份/密钥、OpenCode 数据。
- 清理后 `mcbot.service` active、`/healthz` 返回 `version=1.0.6/contractVersion=1`；回滚目标 `20261030T120449Z` 存在。

## 防复发

- `apps/mcbot/scripts/deploy.ps1` 新增 `-KeepReleases`（默认 **3**）和部署成功后清理逻辑；`current` 与刚部署前的 `previous` 永不删除，传入值小于 2 时按 2 保护。
- app 部署已有“保留最新 3 个、保护 current/previous”逻辑，无需改动。
- legacy `lofii-bot` 不再部署；保留一个 current 以便回滚，后续确认不再需要时可再释放约 471 MiB。
- 建议把根分区可用空间告警阈值设为 **≥15%**；当前 36 G 可用，已恢复充足余量。

## 关联

- 部署说明：[mcbot/DEPLOY.md](../mcbot/DEPLOY.md)
- v1.0.6 验收：[ACCEPTANCE.md](ACCEPTANCE.md)

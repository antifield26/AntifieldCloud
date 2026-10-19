# 备份与恢复

> 目标：SD 卡损坏、误删、升级失败时，能恢复 `/var/lib/antifieldcloud` 的文件与 SQLite 元数据。
> 备份不包含 `/etc/antifieldcloud/env`（含 RCON/opencode 密码）；重建环境文件使用 `scripts/bootstrap-env.sh`。

## 1. 策略

- **频率**：每日一次；周日全量，其余增量。
- **增量依据**：文件内容不可变，只备份 `created_at > 上次成功备份时间` 的新增文件；重命名/移动只改元数据，由 DB 快照覆盖。
- **执行者**：Pi 端 `scripts/backup.mjs` 生成归档；Windows PC 每日 12:00（登录后补跑）拉取到
  `%USERPROFILE%\AntifieldCloudBackups`，成功后删除 Pi 上的归档。
- **保留**：Pi 上最多 2 个待拉取归档；PC 保留 30 份 daily + 8 份 weekly；数据库快照随每个归档。
- **空间保护**：生成前检查剩余空间（估算大小 + 2 GiB），不足则拒绝并返回 JSON 错误；不推进备份游标。
- **完整性**：归档计算 SHA-256，PC 下载后再次校验；不一致则保留远端文件并告警。

## 2. 归档结构

```text
snapshot-20261019T170000Z-full.tar.gz
├── backups/db-20261019T170000Z.sqlite    # 一致性 DB 快照
├── backups/manifest-20261019T170000Z.json
└── files/<xx>/<id>                        # 本次新增/全量文件内容
```

`manifest.json` 字段：`schema / createdAt / mode(full|inc) / since / database / files[] / fileCount / totalBytes`。

## 3. 手动执行（Pi）

```bash
# 增量（若无历史则自动全量）
sudo -u antifieldcloud -H /usr/local/bin/node /opt/antifieldcloud/current/scripts/backup.mjs

# 强制全量
sudo -u antifieldcloud -H /usr/local/bin/node /opt/antifieldcloud/current/scripts/backup.mjs --full
```

stdout 为单行 JSON：`{ok, mode, archive, archiveName, sizeBytes, sha256, fileCount, totalBytes, createdAt}`；
失败时 `{ok:false,error}` 且退出码 1。归档在 `/var/lib/antifieldcloud/backups`，权限 0640（组 `antifield`）。

## 4. Windows 计划任务

```powershell
# 以管理员身份打开 PowerShell（Register-ScheduledTask 需要提权）
cd "$env:USERPROFILE\projects\AntifieldCloud"
.\scripts\install-backup-task.ps1 -PiHost 192.0.2.10 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups"
Get-ScheduledTask -TaskName "AntifieldCloud-Backup-Pull"
```

> `-PiHost` 替换为 Pi 实际直连地址；`-BackupRoot` 可改为任意本地目录（默认 `%USERPROFILE%\AntifieldCloudBackups`）。

- 任务名：`AntifieldCloud-Backup-Pull`；触发：每日 12:00 + 登录后 10 分钟补跑；仅当前用户登录时运行。
- 脚本副本：`%LOCALAPPDATA%\AntifieldCloud\backup-pull.ps1`；日志同目录 `backup.log`。
- 旧任务 `PiBackUp-Nightly` 保持原样，不修改。
- 直连网线未连接时任务失败并记录；面板“备份”卡片超过 48 h 显示红色告警。

## 5. 恢复（演练过的步骤）

> 恢复前先停止应用；恢复期间不要上传文件。建议先在临时目录解压校验，再替换生产数据。

```bash
sudo systemctl stop antifieldcloud
RESTORE=/tmp/antifieldcloud-restore
rm -rf "$RESTORE" && mkdir -p "$RESTORE"

# 1) 最近一次全量
tar -xzf /path/to/snapshot-<ts>-full.tar.gz -C "$RESTORE"

# 2) 按时间顺序叠加增量（full 之后、当前之前）
for f in /path/to/snapshot-<ts2>-inc.tar.gz ...; do
  tar -xzf "$f" -C "$RESTORE"
done

# 3) 校验 manifest 与文件数量
cat "$RESTORE/backups/manifest-"*.json | head

# 4) 替换数据（保留旧数据以便回退）
sudo mv /var/lib/antifieldcloud /var/lib/antifieldcloud.before-restore
sudo install -d -o antifieldcloud -g antifield -m 0750 /var/lib/antifieldcloud
sudo install -d -o antifieldcloud -g antifieldcloud -m 0700 /var/lib/antifieldcloud/files /var/lib/antifieldcloud/tmp
sudo install -d -o antifieldcloud -g antifield -m 2770 /var/lib/antifieldcloud/backups
sudo cp "$RESTORE/backups/db-"*.sqlite /var/lib/antifieldcloud/db.sqlite
sudo cp -a "$RESTORE/files/." /var/lib/antifieldcloud/files/
sudo chown -R antifieldcloud:antifieldcloud /var/lib/antifieldcloud
sudo rm -f /var/lib/antifieldcloud/db.sqlite-wal /var/lib/antifieldcloud/db.sqlite-shm

# 5) 启动并验证
sudo systemctl start antifieldcloud
curl -fsS http://127.0.0.1:3000/healthz
```

验证：
1. 登录成功（TOTP 仍有效，因为 DB 快照含用户与 TOTP secret）。
2. 文件列表数量、随机抽样的 SHA-256 与界面显示一致。
3. 打开一个图片/文本/PDF 预览。
4. 白名单列表与备份时一致（RCON 可用时）。
5. 删除 `/var/lib/antifieldcloud.before-restore` 前确认无误。

## 6. 演练

每季度（或升级前）执行一次：
- 在临时目录解压最新全量 + 增量，确认 `manifest.fileCount` 与 `files/` 数量一致；
- 抽查 3 个文件的 SHA-256；
- 记录演练日期与结果到 `docs/BACKUP.md` 或 CHANGELOG。

## 7. 安全

- 备份包含 DB（用户、TOTP secret、会话、文件元数据）与文件内容；`%USERPROFILE%\AntifieldCloudBackups` 仅当前
  Windows 用户可读（安装脚本沿用目录 ACL）。不要上传到公开网盘。
- `/etc/antifieldcloud/env` 不备份；重装时用 `bootstrap-env.sh` 从现有服务重新生成。
- 恢复后建议在设置页“退出全部会话”并重新生成恢复码（如怀疑泄露）。

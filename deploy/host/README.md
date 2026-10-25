# 主机级配置模板（v0.7.0 / OPS-09）

本目录是 **Pi 重建时可从仓库复现的主机配置模板**（真实部署值不在此目录，见 `.local/DEPLOYMENT.md`）。
安装前请把示例占位值替换为实际值：

| 占位 | 含义 | 替换为 |
|---|---|---|
| `<SSH_USER>` | 运维登录用户（默认示例 `antifield`） | 实际 SSH 用户 |
| `192.0.2.0/24` | 直连网段占位（TEST-NET-1） | 实际直连网段（见 .local/DEPLOYMENT.md） |
| `198.51.100.0/24` | 校园网/无线网段占位（TEST-NET-2） | 实际无线网段 |
| `<TUNNEL_ID>` | Cloudflare Tunnel UUID | `cloudflared tunnel list` 输出 |

文件与安装位置：

| 模板 | 安装位置 | 说明 |
|---|---|---|
| `sshd_config.d/00-antifield-hardening.conf` | `/etc/ssh/sshd_config.d/` | 仅公钥、禁用密码/键盘交互；**先保留已建立 SSH 会话作为回滚通道** |
| `fail2ban/jail.d/antifieldcloud.local` | `/etc/fail2ban/jail.d/` | sshd jail，nftables 后端，24h 封禁，dbfile 持久化 |
| `cloudflared.service.d/20-hardening.conf` | `/etc/systemd/system/cloudflared.service.d/` | cloudflared 加固（不改 tunnel/credentials） |
| `journald.conf.d/60-workbench-persistent.conf` | `/etc/systemd/journald.conf.d/` | 日志持久化与容量上限 |
| `log2ram.conf` | `/etc/log2ram.conf` | log2ram 容量（已安装 log2ram 时） |

安装顺序（详见 `docs/DEPLOY.md`）：

1. 备份现有文件（`cp -a` 到 `/root/host-config-backup-<UTC>/`）；
2. 复制模板并替换占位值（`sed`/编辑器）；
3. `sshd -t && systemctl reload ssh`；确认新会话可公钥登录后再关闭旧回滚会话（24h 窗口）；
4. `systemctl daemon-reload && systemctl restart fail2ban`（`nftables` 重载后 fail2ban set 需要恢复，见 `deploy/systemd/nftables.service.d/10-fail2ban-restore.conf`）；
5. `systemctl restart systemd-journald`（日志持久化配置生效）；
6. 需要时 `systemctl restart cloudflared`，并确认隧道 active、公网 `/healthz` 200。

回滚：从备份目录恢复对应文件 → `sshd -t && systemctl reload ssh`（SSH 相关）/ `systemctl daemon-reload` + 对应服务 restart。

安全提示：
- 修改 `nftables` 的 SSH 来源网段前，先确认**当前** SSH 来源在允许集合内（否则会锁死）；保留物理键鼠或已建立的 SSH 会话；
- 本目录模板不含任何密钥/凭据；`deploy/cloudflared-ingress.yml` 只含 ingress 示例（Tunnel 凭据仍在 `/etc/cloudflared/`）；
- `backup-secrets.sh --include-host-config` 可把这些“已安装后的实际文件”打进 age 加密的密钥包，便于 Pi 重建。

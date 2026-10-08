#!/usr/bin/env bash
# Pi 侧快照准备（workbench 身份，无需 sudo）：wb.db + opencode.db 一致性快照 + 配置打包 + sha256 + backups 行。
set -euo pipefail
TS=$(date +%Y%m%d_%H%M%S)
OUT=/var/lib/workbench/backups/$TS
mkdir -p "$OUT"
sqlite3 /var/lib/workbench/wb.db ".backup '$OUT/wb.db'"
sqlite3 /home/workbench/.local/share/opencode/opencode.db ".backup '$OUT/opencode.db'" || echo "opencode.db backup rc=$?"
tar -czf "$OUT/config.tar.gz" -C /opt/workbench config
cp -a /etc/workbench/env "$OUT/env" 2>/dev/null || echo "env copy rc=$?"
chmod 600 "$OUT/env" 2>/dev/null || true
# PC 拉取用户 antifield 经 SFTP 取快照：仅对 env 副本授予单文件读 ACL（其余文件默认 644）
setfacl -m u:antifield:r -- "$OUT/env" 2>/dev/null || echo "setfacl rc=$?"
(cd "$OUT" && sha256sum wb.db opencode.db config.tar.gz env > sha256sums.txt)
BYTES=$(du -sb "$OUT" | cut -f1)
SUM=$(cut -d' ' -f1 "$OUT/sha256sums.txt" | sha256sum | cut -d' ' -f1)
sqlite3 /var/lib/workbench/wb.db "INSERT INTO backups(id,ts,target,bytes,sha256,status,log) VALUES ('$TS','$(date -u +%FT%TZ)','pi-local-snapshot',$BYTES,'$SUM','ok','snapshot ready for PC pull');"
find /var/lib/workbench/backups -maxdepth 1 -mindepth 1 -mtime +7 -exec rm -rf {} +
echo "SNAPSHOT_OK $TS bytes=$BYTES"

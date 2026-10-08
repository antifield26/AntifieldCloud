#!/usr/bin/env bash
# 恢复演练：快照解到 /tmp/restore-drill-<TS>/，完整性+行数核对，不碰线上库。
set -euo pipefail
TS=${1:?usage: restore-drill.sh <SNAPSHOT_TS>}
SRC=/var/lib/workbench/backups/$TS
DST=/tmp/restore-drill-$TS
rm -rf "$DST"; mkdir -p "$DST"
(cd "$SRC" && sha256sum -c sha256sums.txt)
cp -a "$SRC/wb.db" "$SRC/opencode.db" "$DST/"
tar -xzf "$SRC/config.tar.gz" -C "$DST/"
echo "--- integrity ---"
sqlite3 "$DST/wb.db" 'PRAGMA integrity_check;'
sqlite3 "$DST/opencode.db" 'PRAGMA integrity_check;'
echo "--- row counts ---"
sqlite3 "$DST/wb.db" "SELECT 'metrics_ts='||COUNT(*) FROM metrics_ts;"
sqlite3 "$DST/wb.db" "SELECT 'service_audit='||COUNT(*) FROM service_audit;"
sqlite3 "$DST/wb.db" "SELECT 'backups='||COUNT(*) FROM backups;"
echo "DRILL_OK $TS -> $DST"

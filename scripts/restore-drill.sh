#!/usr/bin/env bash
# 恢复演练：快照解到 /tmp/restore-drill-<TS>/，完整性+行数核对，不碰线上库。
# 结果记 job_runs(job_id='drill') 供 watchdog 检查；演练目录用后即删。
set -euo pipefail
TS=${1:?usage: restore-drill.sh <SNAPSHOT_TS>}
SRC=/var/lib/workbench/backups/$TS
DST=/tmp/restore-drill-$TS
DB=/var/lib/workbench/wb.db
sqlite3 "$DB" "INSERT OR IGNORE INTO jobs(id,name,cron,kind,payload,enabled,last_run,last_status) VALUES ('drill','restore-drill','','monitor','{}',0,null,null);"
RUN=$(sqlite3 "$DB" "INSERT INTO job_runs(id,job_id,started_at,finished_at,status,log) VALUES (lower(hex(randomblob(16))),'drill',strftime('%Y-%m-%dT%H:%M:%SZ','now'),null,'running','') RETURNING id;")
finish() { # $1 status, $2 logfile
  LOG=$(tail -c 4000 "$2" 2>/dev/null || echo "$2")
  sqlite3 "$DB" "UPDATE job_runs SET finished_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),status='$1',log='$LOG' WHERE id='$RUN'; UPDATE jobs SET last_run=strftime('%Y-%m-%dT%H:%M:%SZ','now'),last_status='$1' WHERE id='drill';"
}
LOGF=$(mktemp)
cleanup() { rm -rf "$DST"; }
trap cleanup EXIT
{
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
  echo "DRILL_OK $TS"
} >"$LOGF" 2>&1 && finish ok "$LOGF" || { finish failed "$LOGF"; cat "$LOGF"; rm -f "$LOGF"; exit 1; }
cat "$LOGF"; rm -f "$LOGF"

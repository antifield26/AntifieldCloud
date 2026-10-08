#!/usr/bin/env bash
# 周演练包装：取最新快照跑 restore-drill.sh（结果进 job_runs，目录自清）。
set -euo pipefail
LATEST=$(ls -t /var/lib/workbench/backups/ | head -n 1)
if [ -z "$LATEST" ]; then
  echo "DRILL_FAIL no snapshots"
  exit 1
fi
exec /opt/workbench/restore-drill.sh "$LATEST"

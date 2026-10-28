param(
  [string]$PiHost = "169.254.77.10",
  [string]$PiUser = "antifield",
  [ValidateSet("Plan", "Apply", "Verify", "Rollback")]
  [string]$Mode = "Plan",
  [switch]$SkipMcbot,
  [string]$ExpectedMcbotVersion = "1.0.0",
  [string]$BackupRoot = "/var/backups/antifieldcomplexx",
  [string]$BackupDir = "",
  [int]$TimeoutSec = 600
)

# v1.0.0 生产迁移（QQ Bot→chatbot / lofii-bot→mcbot）。仅 PC 端运行，全部写操作经 ssh + sudo。
#
# 推荐顺序（维护窗口，涉及停机）：
#   1) .\apps\mcbot\scripts\deploy.ps1 -SkipChecks    # 先把新 mcbot release 部署到 /opt/mcbot/current
#   2) .\scripts\migrate-v1.0.0.ps1 -Mode Plan        # 只读预检
#   3) .\scripts\migrate-v1.0.0.ps1 -Mode Apply       # 备份 + app env 键迁移 + 上下文目录 + mcbot 服务/数据切换
#   4) .\scripts\deploy.ps1                           # 部署 app v1.0.0（schema v18，启动新版本）
#   5) .\scripts\migrate-v1.0.0.ps1 -Mode Verify      # 校验 schema/服务/env
#   6) .\scripts\smoke.ps1 -ExpectedVersion 1.0.0 -ExpectedMcbotVersion <mcbot版本>
# 回滚：先 migrate -Mode Rollback（恢复旧 env + lofii-bot 服务/数据），再把 app release 切回旧版
#       并恢复部署前 DB 快照（deploy.ps1 已自动做迁移前快照）。
#
# 边界：不删除旧数据/旧 release；不重启 Minecraft；不修改 QQ/Cloudflare 后台配置（脚本末尾列出人工步骤）。

$ErrorActionPreference = "Stop"
try { $PSNativeCommandUseErrorActionPreference = $false } catch { }

# 输入校验：所有值都会拼进远端 sudo bash 脚本，禁止空白/引号/命令替换字符。
if ($PiHost -notmatch '^[A-Za-z0-9.:-]+$') { throw "PiHost contains invalid characters: $PiHost" }
if ($PiUser -notmatch '^[A-Za-z0-9._-]+$') { throw "PiUser contains invalid characters: $PiUser" }
if ($ExpectedMcbotVersion -notmatch '^\d+\.\d+\.\d+$') { throw "ExpectedMcbotVersion must be x.y.z: $ExpectedMcbotVersion" }
foreach ($remotePath in @($BackupRoot, $BackupDir)) {
  if ([string]::IsNullOrWhiteSpace($remotePath)) { continue }
  if ($remotePath -notmatch '^/[A-Za-z0-9._/-]+$') { throw "backup path must be an absolute safe path: $remotePath" }
}
$target = "$PiUser@$PiHost"
$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$backup = if ([string]::IsNullOrWhiteSpace($BackupDir)) { "$BackupRoot/v1.0.0-$stamp" } else { $BackupDir }

function Invoke-Remote {
  param([string]$Command, [int]$TimeoutSeconds = 120)
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $out = & ssh.exe -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 $target $Command 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldPreference
  }
  return [pscustomobject]@{ Code = $code; Output = (($out | ForEach-Object { "$_" }) -join "`n").Trim() }
}

function Invoke-RemoteScript {
  param([string]$Script, [int]$TimeoutSeconds = 120, [string]$Label = "")
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Script))
  $result = Invoke-Remote -Command "echo '$encoded' | base64 -d | sudo bash" -TimeoutSeconds $TimeoutSeconds
  if ($result.Code -ne 0) {
    throw "$Label failed (exit $($result.Code)):`n$($result.Output)"
  }
  if (-not [string]::IsNullOrWhiteSpace($result.Output)) { Write-Host $result.Output }
  return $result.Output
}

function Get-RemoteScript([string]$template) {
  return $template.Replace("__STAMP__", $stamp).Replace("__BACKUP__", $backup).Replace("__BACKUP_ROOT__", $BackupRoot).Replace("__EXPECTED_MCBOT_VERSION__", $ExpectedMcbotVersion).Replace("__SKIP_MCBOT__", $(if ($SkipMcbot) { "1" } else { "0" }))
}

$planScript = @'
set -euo pipefail
echo "== v1.0.0 migration plan (read-only) =="
echo "host=$(hostname) time=$(date -u +%FT%TZ)"
echo "-- app --"
echo "app_release=$(readlink -f /opt/antifieldcloud/current 2>/dev/null || echo none)"
if [ -f /opt/antifieldcloud/current/apps/workbench/package.json ]; then
  echo "app_version=$(grep -m1 '\"version\"' /opt/antifieldcloud/current/apps/workbench/package.json | sed 's/[^0-9.]//g')"
fi
for svc in antifieldcloud mcbot lofii-bot; do
  echo "service_${svc}=$(systemctl is-active "$svc" 2>/dev/null || true)"
done
echo "app_env_exists=$([ -f /etc/antifieldcloud/env ] && echo yes || echo no)"
echo "app_env_old_keys=$(grep -cE '^(BOT_|LOFII_)' /etc/antifieldcloud/env 2>/dev/null || true)"
echo "app_env_new_keys=$(grep -cE '^(CHATBOT_|MCBOT_)' /etc/antifieldcloud/env 2>/dev/null || true)"
echo "old_context_dir=$([ -d /var/lib/antifieldcloud-context ] && echo yes || echo no)"
echo "new_context_dir=$([ -d /var/lib/antifieldcloud-chatbot-context ] && echo yes || echo no)"
echo "-- mcbot --"
echo "mcbot_release=$(readlink -f /opt/mcbot/current 2>/dev/null || echo none)"
if [ -f /opt/mcbot/current/apps/mcbot/package.json ]; then
  echo "mcbot_release_version=$(grep -m1 '\"version\"' /opt/mcbot/current/apps/mcbot/package.json | sed 's/[^0-9.]//g')"
fi
echo "mcbot_user=$(id -u mcbot 2>/dev/null || echo missing)"
echo "old_bot_env=$([ -f /etc/lofii-bot/env ] && echo yes || echo no)"
echo "new_bot_env=$([ -f /etc/mcbot/env ] && echo yes || echo no)"
echo "old_bot_data=$([ -d /var/lib/lofii-bot ] && echo yes || echo no)"
echo "new_bot_data=$([ -d /var/lib/mcbot ] && echo yes || echo no)"
echo "old_bot_unit=$([ -f /etc/systemd/system/lofii-bot.service ] && echo yes || echo no)"
echo "new_bot_unit=$([ -f /etc/systemd/system/mcbot.service ] && echo yes || echo no)"
echo "backup_root_exists=$([ -d __BACKUP_ROOT__ ] && echo yes || echo no)"
echo "latest_backup=$(ls -1dt __BACKUP_ROOT__/v1.0.0-* 2>/dev/null | head -n1 || true)"
echo "disk_avail=$(df -h /var/lib | tail -n1)"
echo "== plan only; nothing changed =="
'@

$applyScript = @'
set -euo pipefail
STAMP="__STAMP__"
BACKUP="__BACKUP__"
APP_ENV=/etc/antifieldcloud/env
OLD_CONTEXT=/var/lib/antifieldcloud-context
NEW_CONTEXT=/var/lib/antifieldcloud-chatbot-context
EXPECTED_MCBOT_VERSION="__EXPECTED_MCBOT_VERSION__"
SKIP_MCBOT="__SKIP_MCBOT__"

[ "$(id -u)" -eq 0 ] || { echo "must run as root (sudo bash)" >&2; exit 1; }
install -d -m 0700 "$BACKUP"
echo "backup_dir=$BACKUP"
df -h /var/lib | tail -n1

# 1) app env 备份 + 键迁移（BOT_→CHATBOT_，LOFII_→MCBOT_，路径重写，旧键优先去重）
[ -f "$APP_ENV" ] || { echo "missing $APP_ENV" >&2; exit 1; }
cp -a "$APP_ENV" "$BACKUP/app.env"
TMP_FILE="$(mktemp)"
chmod 600 "$TMP_FILE"
{
  grep -E '^BOT_' "$APP_ENV" | sed 's/^BOT_/CHATBOT_/' || true
  grep -E '^LOFII_' "$APP_ENV" | sed 's/^LOFII_/MCBOT_/' || true
  grep -vE '^(BOT_|LOFII_)' "$APP_ENV" || true
} | sed -e 's#/var/lib/antifieldcloud-context#/var/lib/antifieldcloud-chatbot-context#g' -e 's#^WEB_DIST_DIR=.*#WEB_DIST_DIR=/opt/antifieldcloud/current/apps/workbench/web/dist#' | awk -F= '!seen[$1]++' > "$TMP_FILE"
install -m 0640 -o root -g antifieldcloud "$TMP_FILE" "$APP_ENV"
rm -f "$TMP_FILE"
echo "app_env_migrated=yes"

# 2) 上下文文档目录迁移（不删旧目录；失败则中止）
if [ -d "$OLD_CONTEXT" ] && [ ! -e "$NEW_CONTEXT" ]; then
  mv "$OLD_CONTEXT" "$NEW_CONTEXT"
  echo "context_dir_moved=yes"
fi
if [ -d "$NEW_CONTEXT" ]; then
  chown antifieldcloud:opencode "$NEW_CONTEXT"
  chmod 2750 "$NEW_CONTEXT"
  echo "context_dir_ready=yes"
fi

if [ "$SKIP_MCBOT" = "1" ]; then
  echo "skip_mcbot=yes"
  echo "next: deploy app release (schema v18), then run -Mode Verify"
  exit 0
fi

# 3) mcbot 用户/目录/数据/环境/服务切换（旧 lofii-bot 数据与 unit 保留用于回滚）
MCBOT_RELEASE=/opt/mcbot/current
[ -f "$MCBOT_RELEASE/apps/mcbot/package.json" ] || { echo "mcbot release missing: $MCBOT_RELEASE/apps/mcbot/package.json" >&2; exit 1; }
release_version="$(grep -m1 '"version"' "$MCBOT_RELEASE/apps/mcbot/package.json" | sed 's/[^0-9.]//g')"
[ "$release_version" = "$EXPECTED_MCBOT_VERSION" ] || { echo "mcbot release version $release_version != $EXPECTED_MCBOT_VERSION" >&2; exit 1; }

if ! getent group mcbot >/dev/null 2>&1; then addgroup --system mcbot; fi
if ! id mcbot >/dev/null 2>&1; then
  adduser --system --ingroup mcbot --home /var/lib/mcbot --shell /usr/sbin/nologin --no-create-home mcbot
fi
install -d -o root -g root -m 0755 /etc/mcbot
install -d -o mcbot -g mcbot -m 0700 /var/lib/mcbot /var/lib/mcbot/memory

if [ -f /etc/lofii-bot/env ]; then
  cp -a /etc/lofii-bot/env "$BACKUP/lofii-bot.env"
  sed -e 's#/var/lib/lofii-bot#/var/lib/mcbot#g' -e 's#/opt/lofii-bot#/opt/mcbot#g' -e 's#/etc/lofii-bot#/etc/mcbot#g' /etc/lofii-bot/env > "$BACKUP/mcbot.env.new"
  install -m 0640 -o root -g mcbot "$BACKUP/mcbot.env.new" /etc/mcbot/env
  rm -f "$BACKUP/mcbot.env.new"
  echo "bot_env_migrated=yes"
fi

if [ -d /var/lib/lofii-bot ] && [ ! -f /var/lib/mcbot/history.db ]; then
  cp -a /var/lib/lofii-bot/. /var/lib/mcbot/
  chown -R mcbot:mcbot /var/lib/mcbot
  echo "bot_data_migrated=yes"
fi

cp -a /etc/systemd/system/lofii-bot.service "$BACKUP/lofii-bot.service" 2>/dev/null || true
cp -a /etc/systemd/system/mcbot.service "$BACKUP/mcbot.service.bak" 2>/dev/null || true
install -m 0644 "$MCBOT_RELEASE/apps/mcbot/deploy/mcbot.service" /etc/systemd/system/mcbot.service
systemctl daemon-reload

systemctl stop lofii-bot.service 2>/dev/null || true
systemctl disable lofii-bot.service 2>/dev/null || true
systemctl enable mcbot.service
systemctl restart mcbot.service
healthy=0
for i in $(seq 1 30); do
  if curl -fsS --max-time 5 http://127.0.0.1:3010/healthz > /tmp/mcbot-health.json 2>/dev/null; then healthy=1; break; fi
  sleep 2
done
if [ "$healthy" != "1" ]; then
  echo "mcbot health check failed; rolling back service" >&2
  systemctl disable mcbot.service 2>/dev/null || true
  systemctl stop mcbot.service 2>/dev/null || true
  [ -f /etc/systemd/system/lofii-bot.service ] && systemctl enable --now lofii-bot.service 2>/dev/null || true
  exit 1
fi
health="$(cat /tmp/mcbot-health.json)"
echo "mcbot_health=$health"
echo "$health" | grep -q '"contractVersion":1' || { echo "mcbot contractVersion != 1" >&2; exit 1; }
echo "$health" | grep -q "\"version\":\"$EXPECTED_MCBOT_VERSION\"" || { echo "mcbot health version mismatch (expected $EXPECTED_MCBOT_VERSION)" >&2; exit 1; }

# 4) 把 mcbot 读/控制 Token 同步进 app env（只写不打印 Token）
READ_TOKEN="$(grep -m1 '^HTTP_TOKEN=' /etc/mcbot/env | cut -d= -f2- || true)"
CONTROL_TOKEN="$(grep -m1 '^HTTP_CONTROL_TOKEN=' /etc/mcbot/env | cut -d= -f2- || true)"
if [ -n "$READ_TOKEN" ]; then
  TMP_ENV="$(mktemp)"
  chmod 600 "$TMP_ENV"
  awk -v r="$READ_TOKEN" -v c="$CONTROL_TOKEN" '
    /^MCBOT_READ_TOKEN=/ { print "MCBOT_READ_TOKEN=" r; next }
    /^MCBOT_CONTROL_TOKEN=/ { print "MCBOT_CONTROL_TOKEN=" c; next }
    { print }
  ' "$APP_ENV" > "$TMP_ENV"
  grep -q '^MCBOT_READ_TOKEN=' "$TMP_ENV" || printf 'MCBOT_READ_TOKEN=%s\n' "$READ_TOKEN" >> "$TMP_ENV"
  grep -q '^MCBOT_CONTROL_TOKEN=' "$TMP_ENV" || printf 'MCBOT_CONTROL_TOKEN=%s\n' "$CONTROL_TOKEN" >> "$TMP_ENV"
  install -m 0640 -o root -g antifieldcloud "$TMP_ENV" "$APP_ENV"
  rm -f "$TMP_ENV"
  echo "mcbot_tokens_synced=yes"
fi

echo "apply_done=yes backup=$BACKUP"
echo "next: deploy app release (schema v18), then run -Mode Verify"
'@

$verifyScript = @'
set -euo pipefail
fail() { echo "VERIFY FAIL: $*" >&2; exit 1; }
echo "== v1.0.0 verify =="
echo "app_release=$(readlink -f /opt/antifieldcloud/current 2>/dev/null || echo none)"
echo "mcbot_release=$(readlink -f /opt/mcbot/current 2>/dev/null || echo none)"

systemctl is-active --quiet antifieldcloud.service || fail "antifieldcloud not active"
systemctl is-active --quiet mcbot.service || fail "mcbot not active"
[ -f /etc/antifieldcloud/env ] || fail "missing app env"
if grep -qE '^(BOT_|LOFII_)' /etc/antifieldcloud/env; then fail "old env keys remain"; fi
grep -q '^CHATBOT_SECRET_KEY=' /etc/antifieldcloud/env || fail "missing CHATBOT_SECRET_KEY"
grep -q '^MCBOT_URL=' /etc/antifieldcloud/env || fail "missing MCBOT_URL"
[ -d /var/lib/antifieldcloud-chatbot-context ] || fail "missing chatbot context dir"
[ -f /etc/mcbot/env ] || fail "missing /etc/mcbot/env"
[ -f /etc/systemd/system/mcbot.service ] || fail "missing mcbot unit"

app_health="$(curl -fsS --max-time 5 http://127.0.0.1:3000/healthz)"
echo "app_health=$app_health"
echo "$app_health" | grep -q '"schemaVersion":18' || fail "app schemaVersion != 18"
mcbot_health="$(curl -fsS --max-time 5 http://127.0.0.1:3010/healthz)"
echo "mcbot_health=$mcbot_health"
echo "$mcbot_health" | grep -q '"contractVersion":1' || fail "mcbot contractVersion != 1"
echo "verify_ok=yes"
'@

$rollbackScript = @'
set -euo pipefail
BACKUP="__BACKUP__"
[ -d "$BACKUP" ] || { echo "backup dir missing: $BACKUP" >&2; exit 1; }
echo "== v1.0.0 rollback (service/env) =="
echo "backup=$BACKUP"

systemctl disable mcbot.service 2>/dev/null || true
systemctl stop mcbot.service 2>/dev/null || true

if [ -f "$BACKUP/app.env" ]; then
  install -m 0640 -o root -g antifieldcloud "$BACKUP/app.env" /etc/antifieldcloud/env
  echo "app_env_restored=yes"
fi

if [ -f "$BACKUP/lofii-bot.env" ]; then
  install -d -m 0755 /etc/lofii-bot
  cp -a "$BACKUP/lofii-bot.env" /etc/lofii-bot/env
  echo "lofii_env_restored=yes"
fi

if [ -f "$BACKUP/lofii-bot.service" ]; then
  install -m 0644 "$BACKUP/lofii-bot.service" /etc/systemd/system/lofii-bot.service
  echo "lofii_unit_restored=yes"
fi
systemctl daemon-reload
if [ -f /etc/systemd/system/lofii-bot.service ]; then
  systemctl enable lofii-bot.service
  systemctl restart lofii-bot.service
  sleep 2
  systemctl is-active --quiet lofii-bot.service || { echo "lofii-bot failed to start" >&2; exit 1; }
  echo "lofii_service_active=yes"
fi

echo "note: app release rollback is manual: switch /opt/antifieldcloud/current back to previous release,"
echo "      restore the pre-deploy DB snapshot created by deploy.ps1, then restart antifieldcloud.service."
echo "note: QQ webhook path must be switched back to /api/bot/webhook/* and Cloudflare bypass updated."
echo "rollback_service_ok=yes"
'@

try {
  Write-Host "== v1.0.0 migration mode=$Mode target=$target =="
  if ($Mode -eq "Plan") {
    Invoke-RemoteScript -Script (Get-RemoteScript $planScript) -Label "plan" -TimeoutSeconds $TimeoutSec | Out-Null
  } elseif ($Mode -eq "Apply") {
    Write-Host "backup will be written to $backup on the Pi (root 0700)"
    Invoke-RemoteScript -Script (Get-RemoteScript $applyScript) -Label "apply" -TimeoutSeconds $TimeoutSec | Out-Null
    Write-Host ""
    Write-Host "NEXT: 1) deploy app v1.0.0 (schema v18): .\scripts\deploy.ps1"
    Write-Host "      2) verify: .\scripts\migrate-v1.0.0.ps1 -Mode Verify -BackupDir '$backup'"
  } elseif ($Mode -eq "Verify") {
    Invoke-RemoteScript -Script (Get-RemoteScript $verifyScript) -Label "verify" -TimeoutSeconds $TimeoutSec | Out-Null
    Write-Host "VERIFY OK"
  } else {
    if ([string]::IsNullOrWhiteSpace($BackupDir)) {
      $latest = (Invoke-Remote -Command "ls -1dt $BackupRoot/v1.0.0-* 2>/dev/null | head -n1" -Label "latest backup").Output
      if ([string]::IsNullOrWhiteSpace($latest)) { throw "no backup found under $BackupRoot (pass -BackupDir)" }
      $script:backup = $latest
      Write-Host "using latest backup: $backup"
    }
    Invoke-RemoteScript -Script (Get-RemoteScript $rollbackScript) -Label "rollback" -TimeoutSeconds $TimeoutSec | Out-Null
    Write-Host "ROLLBACK (service/env) 完成；app release/DB 快照需按输出提示手动回滚"
  }
}
catch {
  Write-Host "MIGRATION FAILED: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "人工步骤（后台配置，Agent 不代替）："
Write-Host "  1. QQ 开放平台回调地址改为 https://app.<domain>/api/chatbot/webhook/<chatbotId>"
Write-Host "  2. Cloudflare Access bypass 增加 /api/chatbot/webhook/*（旧 /api/bot/webhook/* 可移除）"
Write-Host "  3. 确认 Windows 每日备份任务已按新版本重装（install-backup-task.ps1）"

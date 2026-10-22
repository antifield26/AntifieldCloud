#!/usr/bin/env bash
# 以 root 生成 /etc/antifieldcloud/env：
# - 从 Minecraft server.properties 读取 RCON 密码；
# - 从 /etc/opencode/opencode.env 读取 OPENCODE_PASSWORD；
# - 非敏感配置（域名/路径/端口/阈值）解析顺序：命令行参数 > 现有 env > deploy.conf > 默认值；
# - --force 只覆盖本脚本管理的键；旧 env 中不认识的键原样保留在文件末尾（OP-03），避免手写配置丢失；
# - APP_VERSION 从当前 release 的 package.json 读取，读不到直接失败（不再回退历史版本号）；
# - 不打印任何密码。
#
# 用法：sudo bash scripts/bootstrap-env.sh [--force] [--dry-run] [选项]
# 可选参数：--app-origin --ai-origin --cookie-domain --mc-public-address
#           --data-dir --web-dist-dir --admin-username --mc-properties --opencode-env
set -euo pipefail

ENV_FILE=${ENV_FILE:-/etc/antifieldcloud/env}
DEPLOY_CONF=${DEPLOY_CONF:-/etc/antifieldcloud/deploy.conf}
FORCE=""
DRY_RUN=""
APP_ORIGIN_ARG=""
AI_ORIGIN_ARG=""
COOKIE_DOMAIN_ARG=""
MC_PUBLIC_ADDRESS_ARG=""
DATA_DIR_ARG=""
WEB_DIST_DIR_ARG=""
ADMIN_USERNAME_ARG=""
MC_PROPERTIES_ARG=""
OPENCODE_ENV_ARG=""

usage() {
  cat >&2 <<'EOF'
用法：sudo bash scripts/bootstrap-env.sh [--force] [--dry-run] [选项]
  --force                     覆盖已存在的 env（本脚本管理的键重新生成，未知键原样保留）
  --dry-run                   只打印将解析出的配置，不写文件
  --app-origin=URL            应用公网地址（默认沿用旧值/example.com）
  --ai-origin=URL             AI 工作区地址
  --cookie-domain=DOMAIN      Cookie 域（如 .example.com）
  --mc-public-address=ADDR    Minecraft 公网地址
  --data-dir=DIR              数据目录
  --web-dist-dir=DIR          web/dist 目录
  --admin-username=NAME       管理员用户名
  --mc-properties=FILE        server.properties 路径
  --opencode-env=FILE         opencode env 路径
非敏感配置也可写入 /etc/antifieldcloud/deploy.conf（KEY=VALUE，一行一个，不提交仓库）。
EOF
}

for arg in "$@"; do
  case "$arg" in
    --force) FORCE="1" ;;
    --dry-run) DRY_RUN="1" ;;
    --app-origin=*) APP_ORIGIN_ARG=${arg#*=} ;;
    --ai-origin=*) AI_ORIGIN_ARG=${arg#*=} ;;
    --cookie-domain=*) COOKIE_DOMAIN_ARG=${arg#*=} ;;
    --mc-public-address=*) MC_PUBLIC_ADDRESS_ARG=${arg#*=} ;;
    --data-dir=*) DATA_DIR_ARG=${arg#*=} ;;
    --web-dist-dir=*) WEB_DIST_DIR_ARG=${arg#*=} ;;
    --admin-username=*) ADMIN_USERNAME_ARG=${arg#*=} ;;
    --mc-properties=*) MC_PROPERTIES_ARG=${arg#*=} ;;
    --opencode-env=*) OPENCODE_ENV_ARG=${arg#*=} ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$arg" >&2; usage; exit 2 ;;
  esac
done

# 本脚本管理的键；其余旧 env 键在 --force 时原样保留（OP-03）。
MANAGED_KEYS=(
  NODE_ENV LOG_LEVEL HOST PORT DATA_DIR WEB_DIST_DIR APP_ORIGIN AI_ORIGIN COOKIE_DOMAIN
  ALLOW_INSECURE_LOOPBACK QUOTA_BYTES MAX_UPLOAD_BYTES MAX_FILES_PER_REQUEST
  TEXT_PREVIEW_BYTES TRASH_RETENTION_DAYS SESSION_TTL_DAYS CHALLENGE_TTL_SECONDS
  AUDIT_RETENTION_DAYS ADMIN_USERNAME MC_HOST MC_PORT RCON_HOST RCON_PORT RCON_PASSWORD
  MC_PUBLIC_ADDRESS MC_SYSTEMD_UNIT MC_PROPERTIES OPENCODE_ENV OPENCODE_URL OPENCODE_USERNAME
  OPENCODE_PASSWORD OPENCODE_HTML_MODE SHARES_ENABLED SHARE_DEFAULT_EXPIRY_HOURS
  SHARE_MAX_EXPIRY_HOURS SHARE_MAX_DOWNLOADS SHARE_MAX_ITEMS ALERTS_ENABLED ALERT_WEBHOOK_URL
  ALERT_WEBHOOK_TYPE ALERT_WEBHOOK_SECRET ALERT_DISK_FREE_PCT ALERT_TEMP_C
  ALERT_BACKUP_MAX_AGE_HOURS ALERT_WORLD_BACKUP_MAX_AGE_HOURS ALERT_DRILL_MAX_AGE_DAYS
  ALERT_COOLDOWN_MINUTES ALERT_CHECK_INTERVAL_SECONDS PI_HEALTH_FILE BACKUP_PULL_FILE
  BACKUP_RESTORE_ENABLED BACKUP_IMPORT_MAX_BYTES BACKUP_RESTORE_PLAN_TTL_MINUTES
  BACKUP_RESTORE_MAX_ENTRIES BACKUP_PREPARE_TIMEOUT_SEC CHUNKED_UPLOAD_ENABLED CHUNK_SIZE_BYTES CHUNK_MAX_FILE_BYTES
  CHUNK_SESSION_TTL_HOURS CHUNK_MAX_CONCURRENT_SESSIONS NOTE_ATTACHMENT_MAX_BYTES
  NOTE_MAX_ATTACHMENTS NOTE_VERSIONS_KEEP METRICS_ENABLED METRICS_SAMPLE_SECONDS
  METRICS_RETENTION_DAYS WORLD_BACKUP_STATUS_FILE WORLD_PULL_STATUS_FILE DRILL_STATUS_FILE
  BOT_ENABLED BOT_SECRET_KEY BOT_WEBHOOK_MAX_BODY_BYTES BOT_DELIVERY_INTERVAL_SECONDS
  BOT_DELIVERY_MAX_ATTEMPTS BOT_EVENT_RETENTION_DAYS BOT_COMMAND_RATE_PER_MINUTE
  BOT_PUBLISH_MAX_SCHEDULED_DAYS BOT_MAX_BOTS
  BOT_AI_ENABLED BOT_AI_PROVIDER BOT_AI_MODEL BOT_AI_TIMEOUT_SECONDS BOT_AI_MAX_PROMPT_CHARS
  BOT_AI_RATE_PER_HOUR BOT_AI_SESSION_RETENTION_DAYS BOT_AI_MEMORY_RETENTION_DAYS BOT_AI_MEMORY_BATCH_MESSAGES BOT_AI_MEMORY_IDLE_FLUSH_SECONDS
  BOT_AI_MAX_REPLY_CHARS BOT_AI_VISION_ENABLED BOT_AI_IMAGE_MAX_BYTES
  TZ APP_VERSION
)

# 从 KEY=VALUE 文件读取一个值；文件不存在/键不存在时输出空串。
read_key() {
  local file=$1
  local key=$2
  if [[ -r "$file" ]]; then
    grep -E "^${key}=" "$file" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '\r' || true
  fi
}

# 解析顺序：命令行 > 现有 env > deploy.conf > 默认值。
resolve_value() {
  local arg=$1
  local existing=$2
  local conf=$3
  local default=$4
  if [[ -n "$arg" ]]; then
    printf '%s' "$arg"
  elif [[ -n "$existing" ]]; then
    printf '%s' "$existing"
  elif [[ -n "$conf" ]]; then
    printf '%s' "$conf"
  else
    printf '%s' "$default"
  fi
}

# 无命令行参数的键：现有 env > deploy.conf > 默认值。
resolve_opt() {
  resolve_value "" "$(read_key "$ENV_FILE" "$1")" "$(read_key "$DEPLOY_CONF" "$1")" "$2"
}

if [[ "$(id -u)" -ne 0 ]]; then
  echo "需要 root 权限（sudo bash scripts/bootstrap-env.sh）" >&2
  exit 1
fi

if [[ -f "$ENV_FILE" && "$FORCE" != "1" ]]; then
  echo "已存在 $ENV_FILE，使用 --force 覆盖（本脚本管理的键重新生成，未知键保留）" >&2
  exit 1
fi

if ! getent group antifieldcloud >/dev/null; then
  echo "服务组 antifieldcloud 不存在：请先创建服务账号与目录" >&2
  exit 1
fi

# 先收集旧 env 中不由本脚本管理的键，--force 时原样保留（不解析、不改写）。
PRESERVED=()
if [[ -r "$ENV_FILE" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)= ]] || continue
    key=${BASH_REMATCH[1]}
    managed=false
    for managed_key in "${MANAGED_KEYS[@]}"; do
      if [[ "$key" == "$managed_key" ]]; then
        managed=true
        break
      fi
    done
    if [[ "$managed" != "true" ]]; then
      PRESERVED+=("$line")
    fi
  done < "$ENV_FILE"
fi

MC_PROPERTIES=$(resolve_value "$MC_PROPERTIES_ARG" "$(read_key "$ENV_FILE" MC_PROPERTIES)" "$(read_key "$DEPLOY_CONF" MC_PROPERTIES)" "/home/antifield/minecraft-server/server.properties")
OPENCODE_ENV=$(resolve_value "$OPENCODE_ENV_ARG" "$(read_key "$ENV_FILE" OPENCODE_ENV)" "$(read_key "$DEPLOY_CONF" OPENCODE_ENV)" "/etc/opencode/opencode.env")

if [[ ! -r "$MC_PROPERTIES" ]]; then
  echo "无法读取 $MC_PROPERTIES" >&2
  exit 1
fi
if [[ ! -r "$OPENCODE_ENV" ]]; then
  echo "无法读取 $OPENCODE_ENV" >&2
  exit 1
fi

RCON_PASSWORD=$(grep -E '^rcon\.password=' "$MC_PROPERTIES" | head -n 1 | cut -d= -f2- || true)
OPENCODE_PASSWORD=$(grep -E '^OPENCODE_PASSWORD=' "$OPENCODE_ENV" | head -n 1 | cut -d= -f2- || true)
if [[ -z "$RCON_PASSWORD" ]]; then
  echo "server.properties 中 rcon.password 为空" >&2
  exit 1
fi
if [[ -z "$OPENCODE_PASSWORD" ]]; then
  echo "/etc/opencode/opencode.env 中 OPENCODE_PASSWORD 为空" >&2
  exit 1
fi

# APP_VERSION 必须来自当前 release 的 package.json；读不到即失败，避免写入历史版本误导 /api/version。
NODE_BIN=${NODE_BIN:-/usr/local/bin/node}
if [[ ! -x "$NODE_BIN" ]]; then
  echo "找不到 Node：$NODE_BIN（用于读取 release 版本号）" >&2
  exit 1
fi
APP_VERSION=$("$NODE_BIN" -p "require('/opt/antifieldcloud/current/package.json').version" 2>/dev/null || true)
if [[ ! "$APP_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "无法从 /opt/antifieldcloud/current/package.json 解析版本号（先完成代码部署）" >&2
  exit 1
fi

APP_ORIGIN=$(resolve_value "$APP_ORIGIN_ARG" "$(read_key "$ENV_FILE" APP_ORIGIN)" "$(read_key "$DEPLOY_CONF" APP_ORIGIN)" "https://app.example.com")
AI_ORIGIN=$(resolve_value "$AI_ORIGIN_ARG" "$(read_key "$ENV_FILE" AI_ORIGIN)" "$(read_key "$DEPLOY_CONF" AI_ORIGIN)" "https://ai.example.com")
COOKIE_DOMAIN=$(resolve_value "$COOKIE_DOMAIN_ARG" "$(read_key "$ENV_FILE" COOKIE_DOMAIN)" "$(read_key "$DEPLOY_CONF" COOKIE_DOMAIN)" ".example.com")
MC_PUBLIC_ADDRESS=$(resolve_value "$MC_PUBLIC_ADDRESS_ARG" "$(read_key "$ENV_FILE" MC_PUBLIC_ADDRESS)" "$(read_key "$DEPLOY_CONF" MC_PUBLIC_ADDRESS)" "mc.example.com:11798")
DATA_DIR=$(resolve_value "$DATA_DIR_ARG" "$(read_key "$ENV_FILE" DATA_DIR)" "$(read_key "$DEPLOY_CONF" DATA_DIR)" "/var/lib/antifieldcloud")
WEB_DIST_DIR=$(resolve_value "$WEB_DIST_DIR_ARG" "$(read_key "$ENV_FILE" WEB_DIST_DIR)" "$(read_key "$DEPLOY_CONF" WEB_DIST_DIR)" "/opt/antifieldcloud/current/web/dist")
ADMIN_USERNAME=$(resolve_value "$ADMIN_USERNAME_ARG" "$(read_key "$ENV_FILE" ADMIN_USERNAME)" "$(read_key "$DEPLOY_CONF" ADMIN_USERNAME)" "antifield")

# v0.2/v0.3 既有可调项：沿用旧 env/deploy.conf，缺失时用服务端默认值。
MAX_UPLOAD_BYTES=$(resolve_opt MAX_UPLOAD_BYTES 104857600)
QUOTA_BYTES=$(resolve_opt QUOTA_BYTES 10737418240)
MAX_FILES_PER_REQUEST=$(resolve_opt MAX_FILES_PER_REQUEST 20)
TEXT_PREVIEW_BYTES=$(resolve_opt TEXT_PREVIEW_BYTES 1048576)
TRASH_RETENTION_DAYS=$(resolve_opt TRASH_RETENTION_DAYS 30)
SESSION_TTL_DAYS=$(resolve_opt SESSION_TTL_DAYS 7)
CHALLENGE_TTL_SECONDS=$(resolve_opt CHALLENGE_TTL_SECONDS 300)
AUDIT_RETENTION_DAYS=$(resolve_opt AUDIT_RETENTION_DAYS 90)
BACKUP_PULL_FILE=$(resolve_opt BACKUP_PULL_FILE "$DATA_DIR/backup-pull.json")
BACKUP_RESTORE_ENABLED=$(resolve_opt BACKUP_RESTORE_ENABLED false)
BACKUP_IMPORT_MAX_BYTES=$(resolve_opt BACKUP_IMPORT_MAX_BYTES 104857600)
BACKUP_RESTORE_PLAN_TTL_MINUTES=$(resolve_opt BACKUP_RESTORE_PLAN_TTL_MINUTES 30)
BACKUP_RESTORE_MAX_ENTRIES=$(resolve_opt BACKUP_RESTORE_MAX_ENTRIES 5000)
BACKUP_PREPARE_TIMEOUT_SEC=$(resolve_opt BACKUP_PREPARE_TIMEOUT_SEC 3300)
CHUNKED_UPLOAD_ENABLED=$(resolve_opt CHUNKED_UPLOAD_ENABLED true)
CHUNK_SIZE_BYTES=$(resolve_opt CHUNK_SIZE_BYTES 8388608)
CHUNK_MAX_FILE_BYTES=$(resolve_opt CHUNK_MAX_FILE_BYTES 5368709120)
CHUNK_SESSION_TTL_HOURS=$(resolve_opt CHUNK_SESSION_TTL_HOURS 24)
CHUNK_MAX_CONCURRENT_SESSIONS=$(resolve_opt CHUNK_MAX_CONCURRENT_SESSIONS 3)
OPENCODE_HTML_MODE=$(resolve_opt OPENCODE_HTML_MODE shim)
SHARES_ENABLED=$(resolve_opt SHARES_ENABLED true)
SHARE_DEFAULT_EXPIRY_HOURS=$(resolve_opt SHARE_DEFAULT_EXPIRY_HOURS 168)
SHARE_MAX_EXPIRY_HOURS=$(resolve_opt SHARE_MAX_EXPIRY_HOURS 720)
SHARE_MAX_DOWNLOADS=$(resolve_opt SHARE_MAX_DOWNLOADS 10000)
ALERTS_ENABLED=$(resolve_opt ALERTS_ENABLED true)
ALERT_WEBHOOK_URL=$(resolve_opt ALERT_WEBHOOK_URL "")
ALERT_WEBHOOK_TYPE=$(resolve_opt ALERT_WEBHOOK_TYPE generic)
ALERT_WEBHOOK_SECRET=$(resolve_opt ALERT_WEBHOOK_SECRET "")
ALERT_DISK_FREE_PCT=$(resolve_opt ALERT_DISK_FREE_PCT 15)
ALERT_TEMP_C=$(resolve_opt ALERT_TEMP_C 80)
ALERT_BACKUP_MAX_AGE_HOURS=$(resolve_opt ALERT_BACKUP_MAX_AGE_HOURS 48)
ALERT_COOLDOWN_MINUTES=$(resolve_opt ALERT_COOLDOWN_MINUTES 360)
ALERT_CHECK_INTERVAL_SECONDS=$(resolve_opt ALERT_CHECK_INTERVAL_SECONDS 300)
PI_HEALTH_FILE=$(resolve_opt PI_HEALTH_FILE /run/antifieldcloud/pi-health.json)

# v0.4.0 新增键：默认值与 server/src/config.ts 保持一致。
NOTE_ATTACHMENT_MAX_BYTES=$(resolve_opt NOTE_ATTACHMENT_MAX_BYTES 26214400)
NOTE_MAX_ATTACHMENTS=$(resolve_opt NOTE_MAX_ATTACHMENTS 100)
NOTE_VERSIONS_KEEP=$(resolve_opt NOTE_VERSIONS_KEEP 20)
SHARE_MAX_ITEMS=$(resolve_opt SHARE_MAX_ITEMS 50)
METRICS_ENABLED=$(resolve_opt METRICS_ENABLED true)
METRICS_SAMPLE_SECONDS=$(resolve_opt METRICS_SAMPLE_SECONDS 60)
METRICS_RETENTION_DAYS=$(resolve_opt METRICS_RETENTION_DAYS 30)
WORLD_BACKUP_STATUS_FILE=$(resolve_opt WORLD_BACKUP_STATUS_FILE "$DATA_DIR/world-backup-status.json")
WORLD_PULL_STATUS_FILE=$(resolve_opt WORLD_PULL_STATUS_FILE "$DATA_DIR/world-pull-status.json")
DRILL_STATUS_FILE=$(resolve_opt DRILL_STATUS_FILE "$DATA_DIR/drill-status.json")
ALERT_WORLD_BACKUP_MAX_AGE_HOURS=$(resolve_opt ALERT_WORLD_BACKUP_MAX_AGE_HOURS 192)
ALERT_DRILL_MAX_AGE_DAYS=$(resolve_opt ALERT_DRILL_MAX_AGE_DAYS 35)

# v0.5.0 Bot：加密密钥只在缺失时生成；--force 必须复用旧 key，否则已存 Token 无法解密。
BOT_ENABLED=$(resolve_opt BOT_ENABLED false)
EXISTING_BOT_KEY=$(read_key "$ENV_FILE" BOT_SECRET_KEY)
BOT_SECRET_KEY=${EXISTING_BOT_KEY:-$(head -c 32 /dev/urandom | base64 | tr -d '\n')}
if [[ -n "$BOT_SECRET_KEY" ]]; then
  bot_key_bytes=$(printf '%s' "$BOT_SECRET_KEY" | base64 -d 2>/dev/null | wc -c | tr -d ' ')
  if [[ "$bot_key_bytes" != "32" ]]; then
    echo "BOT_SECRET_KEY 无效（必须是 32 字节 base64）；为避免破坏已存 Bot 凭据，停止写入" >&2
    exit 1
  fi
fi
BOT_WEBHOOK_MAX_BODY_BYTES=$(resolve_opt BOT_WEBHOOK_MAX_BODY_BYTES 262144)
BOT_DELIVERY_INTERVAL_SECONDS=$(resolve_opt BOT_DELIVERY_INTERVAL_SECONDS 30)
BOT_DELIVERY_MAX_ATTEMPTS=$(resolve_opt BOT_DELIVERY_MAX_ATTEMPTS 5)
BOT_EVENT_RETENTION_DAYS=$(resolve_opt BOT_EVENT_RETENTION_DAYS 7)
BOT_COMMAND_RATE_PER_MINUTE=$(resolve_opt BOT_COMMAND_RATE_PER_MINUTE 120)
BOT_PUBLISH_MAX_SCHEDULED_DAYS=$(resolve_opt BOT_PUBLISH_MAX_SCHEDULED_DAYS 30)
BOT_MAX_BOTS=$(resolve_opt BOT_MAX_BOTS 10)
BOT_AI_ENABLED=$(resolve_opt BOT_AI_ENABLED false)
BOT_AI_PROVIDER=$(resolve_opt BOT_AI_PROVIDER '')
BOT_AI_MODEL=$(resolve_opt BOT_AI_MODEL '')
BOT_AI_TIMEOUT_SECONDS=$(resolve_opt BOT_AI_TIMEOUT_SECONDS 60)
BOT_AI_MAX_PROMPT_CHARS=$(resolve_opt BOT_AI_MAX_PROMPT_CHARS 2000)
BOT_AI_RATE_PER_HOUR=$(resolve_opt BOT_AI_RATE_PER_HOUR 120)
BOT_AI_SESSION_RETENTION_DAYS=$(resolve_opt BOT_AI_SESSION_RETENTION_DAYS 7)
BOT_CHAT_RATE_PER_MINUTE=$(resolve_opt BOT_CHAT_RATE_PER_MINUTE 30)
BOT_AI_MEMORY_MAX_CHARS=$(resolve_opt BOT_AI_MEMORY_MAX_CHARS 4096)
BOT_AI_MEMORY_RETENTION_DAYS=$(resolve_opt BOT_AI_MEMORY_RETENTION_DAYS 365)
BOT_AI_MEMORY_BATCH_MESSAGES=$(resolve_opt BOT_AI_MEMORY_BATCH_MESSAGES 3)
BOT_AI_MEMORY_IDLE_FLUSH_SECONDS=$(resolve_opt BOT_AI_MEMORY_IDLE_FLUSH_SECONDS 120)
BOT_AI_MAX_REPLY_CHARS=$(resolve_opt BOT_AI_MAX_REPLY_CHARS 4000)
BOT_AI_VISION_ENABLED=$(resolve_opt BOT_AI_VISION_ENABLED true)
BOT_AI_IMAGE_MAX_BYTES=$(resolve_opt BOT_AI_IMAGE_MAX_BYTES 10485760)
BOT_CONNECTIVITY_ENABLED=$(resolve_opt BOT_CONNECTIVITY_ENABLED true)
BOT_CONNECTIVITY_INTERVAL_SECONDS=$(resolve_opt BOT_CONNECTIVITY_INTERVAL_SECONDS 60)
BOT_CONNECTIVITY_TIMEOUT_SECONDS=$(resolve_opt BOT_CONNECTIVITY_TIMEOUT_SECONDS 8)

if [[ "$OPENCODE_HTML_MODE" != "shim" && "$OPENCODE_HTML_MODE" != "attributes" && "$OPENCODE_HTML_MODE" != "passthrough" ]]; then
  echo "OPENCODE_HTML_MODE 必须是 shim|attributes|passthrough，实际为：$OPENCODE_HTML_MODE" >&2
  exit 1
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "ENV_FILE=$ENV_FILE"
  echo "DEPLOY_CONF=$DEPLOY_CONF"
  echo "APP_ORIGIN=$APP_ORIGIN"
  echo "AI_ORIGIN=$AI_ORIGIN"
  echo "COOKIE_DOMAIN=$COOKIE_DOMAIN"
  echo "MC_PUBLIC_ADDRESS=$MC_PUBLIC_ADDRESS"
  echo "DATA_DIR=$DATA_DIR"
  echo "WEB_DIST_DIR=$WEB_DIST_DIR"
  echo "ADMIN_USERNAME=$ADMIN_USERNAME"
  echo "MC_PROPERTIES=$MC_PROPERTIES"
  echo "OPENCODE_ENV=$OPENCODE_ENV"
  echo "APP_VERSION=$APP_VERSION"
  echo "NOTE_ATTACHMENT_MAX_BYTES=$NOTE_ATTACHMENT_MAX_BYTES"
  echo "METRICS_ENABLED=$METRICS_ENABLED"
  echo "WORLD_BACKUP_STATUS_FILE=$WORLD_BACKUP_STATUS_FILE"
  echo "DRILL_STATUS_FILE=$DRILL_STATUS_FILE"
  echo "BOT_ENABLED=$BOT_ENABLED（BOT_SECRET_KEY 已配置，不回显）"
  echo "保留的未知键数量=${#PRESERVED[@]}"
  echo "（密码未显示）"
  exit 0
fi

case "$APP_ORIGIN$AI_ORIGIN$COOKIE_DOMAIN" in
  *example.com*)
    echo "警告：仍在使用 example.com 占位域名；请通过参数或 $DEPLOY_CONF 设置真实域名，否则登录/Cookie 会失败。" >&2
    ;;
esac

umask 027
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
cat > "$tmp" <<EOF
# 由 scripts/bootstrap-env.sh 生成；不要提交仓库。
NODE_ENV=production
LOG_LEVEL=info
HOST=127.0.0.1
PORT=3000

DATA_DIR=$DATA_DIR
WEB_DIST_DIR=$WEB_DIST_DIR

APP_ORIGIN=$APP_ORIGIN
AI_ORIGIN=$AI_ORIGIN
COOKIE_DOMAIN=$COOKIE_DOMAIN
ALLOW_INSECURE_LOOPBACK=true

QUOTA_BYTES=$QUOTA_BYTES
MAX_UPLOAD_BYTES=$MAX_UPLOAD_BYTES
MAX_FILES_PER_REQUEST=$MAX_FILES_PER_REQUEST
TEXT_PREVIEW_BYTES=$TEXT_PREVIEW_BYTES
TRASH_RETENTION_DAYS=$TRASH_RETENTION_DAYS
SESSION_TTL_DAYS=$SESSION_TTL_DAYS
CHALLENGE_TTL_SECONDS=$CHALLENGE_TTL_SECONDS
AUDIT_RETENTION_DAYS=$AUDIT_RETENTION_DAYS

ADMIN_USERNAME=$ADMIN_USERNAME

MC_HOST=127.0.0.1
MC_PORT=25565
RCON_HOST=127.0.0.1
RCON_PORT=25575
RCON_PASSWORD=$RCON_PASSWORD
MC_PUBLIC_ADDRESS=$MC_PUBLIC_ADDRESS
MC_SYSTEMD_UNIT=minecraft
MC_PROPERTIES=$MC_PROPERTIES

OPENCODE_URL=http://127.0.0.1:4096
OPENCODE_USERNAME=opencode
OPENCODE_PASSWORD=$OPENCODE_PASSWORD
OPENCODE_ENV=$OPENCODE_ENV
OPENCODE_HTML_MODE=$OPENCODE_HTML_MODE

# 分享与告警（v0.2/v0.3）；webhook/密钥等非敏感值可用 deploy.conf 覆盖后重新生成本文件。
SHARES_ENABLED=$SHARES_ENABLED
SHARE_DEFAULT_EXPIRY_HOURS=$SHARE_DEFAULT_EXPIRY_HOURS
SHARE_MAX_EXPIRY_HOURS=$SHARE_MAX_EXPIRY_HOURS
SHARE_MAX_DOWNLOADS=$SHARE_MAX_DOWNLOADS
SHARE_MAX_ITEMS=$SHARE_MAX_ITEMS
ALERTS_ENABLED=$ALERTS_ENABLED
ALERT_WEBHOOK_URL=$ALERT_WEBHOOK_URL
ALERT_WEBHOOK_TYPE=$ALERT_WEBHOOK_TYPE
ALERT_WEBHOOK_SECRET=$ALERT_WEBHOOK_SECRET
ALERT_DISK_FREE_PCT=$ALERT_DISK_FREE_PCT
ALERT_TEMP_C=$ALERT_TEMP_C
ALERT_BACKUP_MAX_AGE_HOURS=$ALERT_BACKUP_MAX_AGE_HOURS
ALERT_WORLD_BACKUP_MAX_AGE_HOURS=$ALERT_WORLD_BACKUP_MAX_AGE_HOURS
ALERT_DRILL_MAX_AGE_DAYS=$ALERT_DRILL_MAX_AGE_DAYS
ALERT_COOLDOWN_MINUTES=$ALERT_COOLDOWN_MINUTES
ALERT_CHECK_INTERVAL_SECONDS=$ALERT_CHECK_INTERVAL_SECONDS
PI_HEALTH_FILE=$PI_HEALTH_FILE

# 备份管理（v0.3）：恢复默认关闭，需要时改为 true 后重启应用。
BACKUP_PULL_FILE=$BACKUP_PULL_FILE
BACKUP_RESTORE_ENABLED=$BACKUP_RESTORE_ENABLED
BACKUP_IMPORT_MAX_BYTES=$BACKUP_IMPORT_MAX_BYTES
BACKUP_RESTORE_PLAN_TTL_MINUTES=$BACKUP_RESTORE_PLAN_TTL_MINUTES
BACKUP_RESTORE_MAX_ENTRIES=$BACKUP_RESTORE_MAX_ENTRIES
BACKUP_PREPARE_TIMEOUT_SEC=$BACKUP_PREPARE_TIMEOUT_SEC

# 分片上传（v0.3.1）：默认开启，Cloudflare 代理下建议 8 MiB 块。
CHUNKED_UPLOAD_ENABLED=$CHUNKED_UPLOAD_ENABLED
CHUNK_SIZE_BYTES=$CHUNK_SIZE_BYTES
CHUNK_MAX_FILE_BYTES=$CHUNK_MAX_FILE_BYTES
CHUNK_SESSION_TTL_HOURS=$CHUNK_SESSION_TTL_HOURS
CHUNK_MAX_CONCURRENT_SESSIONS=$CHUNK_MAX_CONCURRENT_SESSIONS

# 笔记附件/版本（v0.4.0）。
NOTE_ATTACHMENT_MAX_BYTES=$NOTE_ATTACHMENT_MAX_BYTES
NOTE_MAX_ATTACHMENTS=$NOTE_MAX_ATTACHMENTS
NOTE_VERSIONS_KEEP=$NOTE_VERSIONS_KEEP

# 指标采样与运维状态文件（v0.4.0）。
METRICS_ENABLED=$METRICS_ENABLED
METRICS_SAMPLE_SECONDS=$METRICS_SAMPLE_SECONDS
METRICS_RETENTION_DAYS=$METRICS_RETENTION_DAYS
WORLD_BACKUP_STATUS_FILE=$WORLD_BACKUP_STATUS_FILE
WORLD_PULL_STATUS_FILE=$WORLD_PULL_STATUS_FILE
DRILL_STATUS_FILE=$DRILL_STATUS_FILE

# v0.5.0 Bot：BOT_SECRET_KEY 用于加密平台 Token；与 DB 一起备份，丢失后 Token 需重新录入。
BOT_ENABLED=$BOT_ENABLED
BOT_SECRET_KEY=$BOT_SECRET_KEY
BOT_WEBHOOK_MAX_BODY_BYTES=$BOT_WEBHOOK_MAX_BODY_BYTES
BOT_DELIVERY_INTERVAL_SECONDS=$BOT_DELIVERY_INTERVAL_SECONDS
BOT_DELIVERY_MAX_ATTEMPTS=$BOT_DELIVERY_MAX_ATTEMPTS
BOT_EVENT_RETENTION_DAYS=$BOT_EVENT_RETENTION_DAYS
BOT_COMMAND_RATE_PER_MINUTE=$BOT_COMMAND_RATE_PER_MINUTE
BOT_PUBLISH_MAX_SCHEDULED_DAYS=$BOT_PUBLISH_MAX_SCHEDULED_DAYS
BOT_MAX_BOTS=$BOT_MAX_BOTS
BOT_AI_ENABLED=$BOT_AI_ENABLED
BOT_AI_PROVIDER=$BOT_AI_PROVIDER
BOT_AI_MODEL=$BOT_AI_MODEL
BOT_AI_TIMEOUT_SECONDS=$BOT_AI_TIMEOUT_SECONDS
BOT_AI_MAX_PROMPT_CHARS=$BOT_AI_MAX_PROMPT_CHARS
BOT_AI_RATE_PER_HOUR=$BOT_AI_RATE_PER_HOUR
BOT_AI_SESSION_RETENTION_DAYS=$BOT_AI_SESSION_RETENTION_DAYS
BOT_CHAT_RATE_PER_MINUTE=$BOT_CHAT_RATE_PER_MINUTE
BOT_AI_MEMORY_MAX_CHARS=$BOT_AI_MEMORY_MAX_CHARS
BOT_AI_MEMORY_RETENTION_DAYS=$BOT_AI_MEMORY_RETENTION_DAYS
BOT_AI_MEMORY_BATCH_MESSAGES=$BOT_AI_MEMORY_BATCH_MESSAGES
BOT_AI_MEMORY_IDLE_FLUSH_SECONDS=$BOT_AI_MEMORY_IDLE_FLUSH_SECONDS
BOT_AI_MAX_REPLY_CHARS=$BOT_AI_MAX_REPLY_CHARS
BOT_AI_VISION_ENABLED=$BOT_AI_VISION_ENABLED
BOT_AI_IMAGE_MAX_BYTES=$BOT_AI_IMAGE_MAX_BYTES
BOT_CONNECTIVITY_ENABLED=$BOT_CONNECTIVITY_ENABLED
BOT_CONNECTIVITY_INTERVAL_SECONDS=$BOT_CONNECTIVITY_INTERVAL_SECONDS
BOT_CONNECTIVITY_TIMEOUT_SECONDS=$BOT_CONNECTIVITY_TIMEOUT_SECONDS

TZ=Asia/Shanghai
APP_VERSION=$APP_VERSION
EOF

if [[ ${#PRESERVED[@]} -gt 0 ]]; then
  {
    echo ""
    echo "# 以下键由旧 env 原样保留（bootstrap-env.sh 不管理）；如确认无用可手工删除。"
    for line in "${PRESERVED[@]}"; do
      echo "$line"
    done
  } >> "$tmp"
fi

install -o root -g antifieldcloud -m 0640 "$tmp" "$ENV_FILE"
echo "已写入 $ENV_FILE（权限 0640 root:antifieldcloud），未回显密钥"
echo "非敏感配置来源：命令行 > 现有 env > $DEPLOY_CONF > 默认值"
if [[ ${#PRESERVED[@]} -gt 0 ]]; then
  echo "旧 env 中未知键已原样保留：${#PRESERVED[@]} 个"
fi

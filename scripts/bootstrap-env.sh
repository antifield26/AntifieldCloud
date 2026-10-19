#!/usr/bin/env bash
# 以 root 生成 /etc/antifieldcloud/env：
# - 从 Minecraft server.properties 读取 RCON 密码
# - 从 /etc/opencode/opencode.env 读取 OPENCODE_PASSWORD
# - 非敏感配置（域名/路径/端口）优先沿用现有 env 或 /etc/antifieldcloud/deploy.conf，
#   不会因为 --force 重置回 example.com 占位值
# - 不打印任何密码
#
# 用法：sudo bash scripts/bootstrap-env.sh [--force] [--dry-run] [--app-origin=URL] ...
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
  --force                     覆盖已存在的 env（非敏感配置仍优先沿用旧值）
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

if [[ "$(id -u)" -ne 0 ]]; then
  echo "需要 root 权限（sudo bash scripts/bootstrap-env.sh）" >&2
  exit 1
fi

if [[ -f "$ENV_FILE" && "$FORCE" != "1" ]]; then
  echo "已存在 $ENV_FILE，使用 --force 覆盖（非敏感配置会沿用旧值）" >&2
  exit 1
fi

if ! getent group antifieldcloud >/dev/null; then
  echo "服务组 antifieldcloud 不存在：请先创建服务账号与目录" >&2
  exit 1
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

APP_VERSION=$("${NODE_BIN:-/usr/local/bin/node}" -p "require('/opt/antifieldcloud/current/package.json').version" 2>/dev/null || echo "0.2.0")

APP_ORIGIN=$(resolve_value "$APP_ORIGIN_ARG" "$(read_key "$ENV_FILE" APP_ORIGIN)" "$(read_key "$DEPLOY_CONF" APP_ORIGIN)" "https://app.example.com")
AI_ORIGIN=$(resolve_value "$AI_ORIGIN_ARG" "$(read_key "$ENV_FILE" AI_ORIGIN)" "$(read_key "$DEPLOY_CONF" AI_ORIGIN)" "https://ai.example.com")
COOKIE_DOMAIN=$(resolve_value "$COOKIE_DOMAIN_ARG" "$(read_key "$ENV_FILE" COOKIE_DOMAIN)" "$(read_key "$DEPLOY_CONF" COOKIE_DOMAIN)" ".example.com")
MC_PUBLIC_ADDRESS=$(resolve_value "$MC_PUBLIC_ADDRESS_ARG" "$(read_key "$ENV_FILE" MC_PUBLIC_ADDRESS)" "$(read_key "$DEPLOY_CONF" MC_PUBLIC_ADDRESS)" "mc.example.com:11798")
DATA_DIR=$(resolve_value "$DATA_DIR_ARG" "$(read_key "$ENV_FILE" DATA_DIR)" "$(read_key "$DEPLOY_CONF" DATA_DIR)" "/var/lib/antifieldcloud")
WEB_DIST_DIR=$(resolve_value "$WEB_DIST_DIR_ARG" "$(read_key "$ENV_FILE" WEB_DIST_DIR)" "$(read_key "$DEPLOY_CONF" WEB_DIST_DIR)" "/opt/antifieldcloud/current/web/dist")
ADMIN_USERNAME=$(resolve_value "$ADMIN_USERNAME_ARG" "$(read_key "$ENV_FILE" ADMIN_USERNAME)" "$(read_key "$DEPLOY_CONF" ADMIN_USERNAME)" "antifield")
BACKUP_PULL_FILE=$(resolve_value "" "$(read_key "$ENV_FILE" BACKUP_PULL_FILE)" "$(read_key "$DEPLOY_CONF" BACKUP_PULL_FILE)" "$DATA_DIR/backup-pull.json")
MAX_UPLOAD_BYTES=$(resolve_value "" "$(read_key "$ENV_FILE" MAX_UPLOAD_BYTES)" "$(read_key "$DEPLOY_CONF" MAX_UPLOAD_BYTES)" "104857600")

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

QUOTA_BYTES=10737418240
MAX_UPLOAD_BYTES=$MAX_UPLOAD_BYTES
MAX_FILES_PER_REQUEST=20
TEXT_PREVIEW_BYTES=1048576
TRASH_RETENTION_DAYS=30
SESSION_TTL_DAYS=7
CHALLENGE_TTL_SECONDS=300
AUDIT_RETENTION_DAYS=90

ADMIN_USERNAME=$ADMIN_USERNAME

MC_HOST=127.0.0.1
MC_PORT=25565
RCON_HOST=127.0.0.1
RCON_PORT=25575
RCON_PASSWORD=$RCON_PASSWORD
MC_PUBLIC_ADDRESS=$MC_PUBLIC_ADDRESS
MC_SYSTEMD_UNIT=minecraft

OPENCODE_URL=http://127.0.0.1:4096
OPENCODE_USERNAME=opencode
OPENCODE_PASSWORD=$OPENCODE_PASSWORD

# v0.2.0：分享与告警默认开启；webhook/密钥等非敏感值可用 deploy.conf 覆盖后重新生成本文件。
SHARES_ENABLED=true
SHARE_DEFAULT_EXPIRY_HOURS=168
SHARE_MAX_EXPIRY_HOURS=720
SHARE_MAX_DOWNLOADS=10000
ALERTS_ENABLED=true
ALERT_WEBHOOK_URL=
ALERT_WEBHOOK_TYPE=generic
ALERT_WEBHOOK_SECRET=
ALERT_DISK_FREE_PCT=15
ALERT_TEMP_C=80
ALERT_BACKUP_MAX_AGE_HOURS=48
ALERT_COOLDOWN_MINUTES=360
ALERT_CHECK_INTERVAL_SECONDS=300
PI_HEALTH_FILE=/run/antifieldcloud/pi-health.json

BACKUP_PULL_FILE=$BACKUP_PULL_FILE
TZ=Asia/Shanghai
APP_VERSION=$APP_VERSION
EOF

install -o root -g antifieldcloud -m 0640 "$tmp" "$ENV_FILE"
echo "已写入 $ENV_FILE（权限 0640 root:antifieldcloud），未回显密钥"
echo "非敏感配置来源：命令行 > 现有 env > $DEPLOY_CONF > 默认值"

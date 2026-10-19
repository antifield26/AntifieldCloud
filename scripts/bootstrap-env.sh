#!/usr/bin/env bash
# 以 root 生成 /etc/antifieldcloud/env：
# - 从 Minecraft server.properties 读取 RCON 密码
# - 从 /etc/opencode/opencode.env 读取 OPENCODE_PASSWORD
# - 不打印任何密码
#
# 用法：sudo bash scripts/bootstrap-env.sh [--force]
set -euo pipefail

ENV_FILE=/etc/antifieldcloud/env
FORCE="${1:-}"

if [[ -f "$ENV_FILE" && "$FORCE" != "--force" ]]; then
  echo "已存在 $ENV_FILE，使用 --force 覆盖" >&2
  exit 1
fi

if ! getent group antifieldcloud >/dev/null; then
  echo "服务组 antifieldcloud 不存在：请先创建服务账号与目录" >&2
  exit 1
fi

MC_PROPERTIES=/home/antifield/minecraft-server/server.properties
OPENCODE_ENV=/etc/opencode/opencode.env

if [[ ! -r "$MC_PROPERTIES" ]]; then
  echo "无法读取 $MC_PROPERTIES" >&2
  exit 1
fi
if [[ ! -r "$OPENCODE_ENV" ]]; then
  echo "无法读取 $OPENCODE_ENV" >&2
  exit 1
fi

RCON_PASSWORD="$(grep -E '^rcon\.password=' "$MC_PROPERTIES" | head -n1 | cut -d= -f2- || true)"
OPENCODE_PASSWORD="$(grep -E '^OPENCODE_PASSWORD=' "$OPENCODE_ENV" | head -n1 | cut -d= -f2- || true)"
if [[ -z "$RCON_PASSWORD" ]]; then
  echo "server.properties 中 rcon.password 为空" >&2
  exit 1
fi
if [[ -z "$OPENCODE_PASSWORD" ]]; then
  echo "/etc/opencode/opencode.env 中 OPENCODE_PASSWORD 为空" >&2
  exit 1
fi

APP_VERSION="$(/usr/local/bin/node -p "require('/opt/antifieldcloud/current/package.json').version" 2>/dev/null || echo 0.1.0)"

umask 027
tmp="$(mktemp)"
cat > "$tmp" <<EOF
NODE_ENV=production
LOG_LEVEL=info
HOST=127.0.0.1
PORT=3000

DATA_DIR=/var/lib/antifieldcloud
WEB_DIST_DIR=/opt/antifieldcloud/current/web/dist

APP_ORIGIN=https://app.example.com
AI_ORIGIN=https://ai.example.com
COOKIE_DOMAIN=.example.com
ALLOW_INSECURE_LOOPBACK=true

QUOTA_BYTES=10737418240
MAX_UPLOAD_BYTES=2147483648
MAX_FILES_PER_REQUEST=20
TEXT_PREVIEW_BYTES=1048576
TRASH_RETENTION_DAYS=30
SESSION_TTL_DAYS=7
CHALLENGE_TTL_SECONDS=300
AUDIT_RETENTION_DAYS=90

ADMIN_USERNAME=antifield

MC_HOST=127.0.0.1
MC_PORT=25565
RCON_HOST=127.0.0.1
RCON_PORT=25575
RCON_PASSWORD=$RCON_PASSWORD
MC_PUBLIC_ADDRESS=mc.example.com:11798
MC_SYSTEMD_UNIT=minecraft

OPENCODE_URL=http://127.0.0.1:4096
OPENCODE_USERNAME=opencode
OPENCODE_PASSWORD=$OPENCODE_PASSWORD

BACKUP_PULL_FILE=/var/lib/antifieldcloud/backup-pull.json
TZ=Asia/Shanghai
APP_VERSION=$APP_VERSION
EOF
install -o root -g antifieldcloud -m 0640 "$tmp" "$ENV_FILE"
rm -f "$tmp"
echo "已写入 $ENV_FILE（权限 0640 root:antifieldcloud），未回显密钥"

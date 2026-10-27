#!/usr/bin/env bash
# v0.8.0：把 lofii-bot 的读/控制 Token 同步到 AntifieldCloud env（root 执行）。
#
# 安全边界：
# - 只读取 /etc/lofii-bot/env 的 HTTP_TOKEN/HTTP_CONTROL_TOKEN，绝不读取或复制
#   RCON_PASSWORD/OPENCODE_PASSWORD 等 lofii 其他密钥；
# - 只更新 /etc/antifieldcloud/env 的 LOFII_READ_TOKEN/LOFII_CONTROL_TOKEN；
# - 写前备份 env，原子 install，保持原属主/组与 0640；不回显 Token；
# - 不自动改 LOFII_ENABLED，启用与否由管理员显式决定。
#
# 用法：
#   sudo bash scripts/sync-lofii-tokens.sh
#   sudo bash scripts/sync-lofii-tokens.sh --check   # 只比较，不写盘
set -euo pipefail

LOFII_ENV="${LOFII_ENV:-/etc/lofii-bot/env}"
APP_ENV="${APP_ENV:-/etc/antifieldcloud/env}"
CHECK=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "需要 root 权限（sudo bash scripts/sync-lofii-tokens.sh）" >&2
  exit 1
fi
if [[ ! -r "$LOFII_ENV" ]]; then
  echo "无法读取 $LOFII_ENV（先部署 lofii-bot 并生成 env）" >&2
  exit 1
fi
if [[ ! -r "$APP_ENV" ]]; then
  echo "无法读取 $APP_ENV（先运行 AntifieldCloud bootstrap-env.sh）" >&2
  exit 1
fi

read_key() {
  local file=$1
  local key=$2
  grep -E "^${key}=" "$file" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '\r' || true
}

READ_TOKEN="$(read_key "$LOFII_ENV" HTTP_TOKEN)"
CONTROL_TOKEN="$(read_key "$LOFII_ENV" HTTP_CONTROL_TOKEN)"
if [[ ! "$READ_TOKEN" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "lofii HTTP_TOKEN 缺失或不是 64 位 hex；未写入" >&2
  exit 1
fi
if [[ -n "$CONTROL_TOKEN" && ! "$CONTROL_TOKEN" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "lofii HTTP_CONTROL_TOKEN 不是 64 位 hex；未写入" >&2
  exit 1
fi

CURRENT_READ="$(read_key "$APP_ENV" LOFII_READ_TOKEN)"
CURRENT_CONTROL="$(read_key "$APP_ENV" LOFII_CONTROL_TOKEN)"
READ_MATCH=0
CONTROL_MATCH=0
[[ "$CURRENT_READ" == "$READ_TOKEN" ]] && READ_MATCH=1
[[ "$CURRENT_CONTROL" == "$CONTROL_TOKEN" ]] && CONTROL_MATCH=1

if [[ "$CHECK" == "1" ]]; then
  echo "Lofii Token 一致性：read=$([[ "$READ_MATCH" == "1" ]] && echo match || echo mismatch) control=$([[ "$CONTROL_MATCH" == "1" ]] && echo match || echo mismatch)"
  if [[ "$READ_MATCH" == "1" && "$CONTROL_MATCH" == "1" ]]; then exit 0; fi
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
cp -a "$APP_ENV" "$APP_ENV.lofii-tokens.bak.$STAMP"
OWNER="$(stat -c '%u:%g' "$APP_ENV")"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# 删除旧 LOFII Token 行（保留其他键/注释/顺序），再追加新值；Token 不进入 argv。
grep -vE '^LOFII_(READ|CONTROL)_TOKEN=' "$APP_ENV" > "$TMP" || true
if [[ -s "$TMP" && "$(tail -c 1 "$TMP" | wc -l)" == "0" ]]; then
  printf '\n' >> "$TMP"
fi
printf 'LOFII_READ_TOKEN=%s\n' "$READ_TOKEN" >> "$TMP"
printf 'LOFII_CONTROL_TOKEN=%s\n' "$CONTROL_TOKEN" >> "$TMP"

install -o "${OWNER%%:*}" -g "${OWNER##*:}" -m 0640 "$TMP" "$APP_ENV"
echo "已同步 Lofii Token 到 $APP_ENV（read_len=${#READ_TOKEN} control_len=${#CONTROL_TOKEN}；未回显 Token）"
echo "env 备份：$APP_ENV.lofii-tokens.bak.$STAMP"
echo "如属性变化，重启 antifieldcloud 生效；不要提交任何 env 文件。"

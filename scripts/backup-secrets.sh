#!/usr/bin/env bash
# 以 root 生成加密密钥备份（age）：
# - 打包 /etc/antifieldcloud/env、cloudflared 配置/凭证、Minecraft server.properties、opencode env
# - 用 age 公钥加密为 secrets-<UTC>.tar.age，并写 .sha256 旁文件
# - 保留最近 N 份（默认 2），由 Windows 备份任务拉取到本地后删除远端
# - 公钥：/etc/antifieldcloud/secrets-age.pub（一行 age1...；私钥离机保存，绝不放在 Pi）
# - stdout 单行 JSON；失败输出 {ok:false,error} 且退出码 1
set -euo pipefail

BACKUP_DIR=${SECRETS_BACKUP_DIR:-/var/lib/antifieldcloud/backups/secrets}
RECIPIENT_FILE=${SECRETS_AGE_RECIPIENT_FILE:-/etc/antifieldcloud/secrets-age.pub}
KEEP=${SECRETS_KEEP:-2}
GROUP=${SECRETS_GROUP:-antifield}

json_error() {
  printf '{"ok":false,"error":"%s"}\n' "$1"
  exit 1
}

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  json_error "需要 root 权限"
fi
if ! command -v age >/dev/null 2>&1; then
  json_error "age 未安装（apt-get install -y age 后重试）"
fi
if [[ ! -r "$RECIPIENT_FILE" ]]; then
  json_error "缺少 age 公钥文件：$RECIPIENT_FILE（age-keygen 生成后把 age1... 写入该文件）"
fi
RECIPIENT=$(head -n 1 "$RECIPIENT_FILE" | tr -d '\r\n')
if [[ -z "$RECIPIENT" ]]; then
  json_error "age 公钥文件为空：$RECIPIENT_FILE"
fi

umask 027
mkdir -p "$BACKUP_DIR"
if getent group "$GROUP" >/dev/null 2>&1; then
  chgrp "$GROUP" "$BACKUP_DIR" 2>/dev/null || true
fi
chmod 2750 "$BACKUP_DIR" 2>/dev/null || chmod 0750 "$BACKUP_DIR"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
name="secrets-${stamp}.tar.age"
archive="$BACKUP_DIR/$name"
sha_file="$archive.sha256"
tmp_tar=$(mktemp)
trap 'rm -f "$tmp_tar"' EXIT

# 只打包实际存在的敏感文件；env 是必需项，缺失说明环境尚未初始化。
files=()
for candidate in \
  /etc/antifieldcloud/env \
  /etc/cloudflared/config.yml \
  /etc/cloudflared/cert.pem \
  /etc/opencode/opencode.env \
  /home/antifield/minecraft-server/server.properties; do
  if [[ -f "$candidate" ]]; then
    files+=("${candidate#/}")
  fi
done
for candidate in /etc/cloudflared/*.json; do
  if [[ -f "$candidate" ]]; then
    files+=("${candidate#/}")
  fi
done
if [[ ! -f /etc/antifieldcloud/env ]]; then
  json_error "缺少 /etc/antifieldcloud/env，无法做密钥备份"
fi
if [[ ${#files[@]} -eq 0 ]]; then
  json_error "没有可备份的密钥文件"
fi

tar -czf "$tmp_tar" -C / "${files[@]}"
age -r "$RECIPIENT" -o "$archive" "$tmp_tar"
chmod 0640 "$archive"
if getent group "$GROUP" >/dev/null 2>&1; then
  chgrp "$GROUP" "$archive" 2>/dev/null || true
fi
sha256=$(sha256sum "$archive" | cut -d' ' -f1)
printf '%s  %s\n' "$sha256" "$name" > "$sha_file"
chmod 0640 "$sha_file"
if getent group "$GROUP" >/dev/null 2>&1; then
  chgrp "$GROUP" "$sha_file" 2>/dev/null || true
fi

# 保留最近 KEEP 份（含本次），删除更旧的归档与旁文件。
mapfile -t stale < <(find "$BACKUP_DIR" -maxdepth 1 -name 'secrets-*.tar.age' -printf '%f\n' | sort -r | tail -n +$((KEEP + 1)))
for old in "${stale[@]}"; do
  rm -f "$BACKUP_DIR/$old" "$BACKUP_DIR/$old.sha256"
done

size=$(stat -c '%s' "$archive")
created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '{"ok":true,"archive":"%s","archiveName":"%s","sha256":"%s","sizeBytes":%s,"fileCount":%s,"createdAt":"%s","keep":%s}\n' \
  "$archive" "$name" "$sha256" "$size" "${#files[@]}" "$created_at" "$KEEP"

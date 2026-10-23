#!/usr/bin/env bash
# 以 root 生成加密密钥备份（age）：
# - 打包 /etc/antifieldcloud/env、cloudflared 配置/凭证、Minecraft server.properties、opencode env；
# - 追加 opencode 配置（opencode.json/service.json）与 opencode 数据库的一致性快照；
# - 明文只在 0700 临时目录内存在，trap 清理；失败不留下未加密产物；
# - 用 age 公钥加密为 secrets-<UTC>.tar.age，并写 .sha256 旁文件；保留最近 N 份并清理孤儿 sidecar；
# - 公钥：/etc/antifieldcloud/secrets-age.pub（一行 age1...，root 所有、组/其他不可写；私钥离机保存）；
# - stdout 单行 JSON；失败输出 {ok:false,error} 且退出码 1；绝不输出密码/密钥。
set -euo pipefail

BACKUP_DIR=${SECRETS_BACKUP_DIR:-/var/lib/antifieldcloud/backups/secrets}
RECIPIENT_FILE=${SECRETS_AGE_RECIPIENT_FILE:-/etc/antifieldcloud/secrets-age.pub}
KEEP=${SECRETS_KEEP:-2}
GROUP=${SECRETS_GROUP:-antifield}
NODE_BIN=${NODE_BIN:-/usr/local/bin/node}
OPENCODE_HOME=${OPENCODE_HOME:-/var/lib/opencode}
OPENCODE_DB=${OPENCODE_DB:-$OPENCODE_HOME/.local/share/opencode/opencode.db}
OPENCODE_CONFIG_DIR=${OPENCODE_CONFIG_DIR:-$OPENCODE_HOME/.config/opencode}
# 明文临时目录优先放 /run（tmpfs，重启即清）；不可用时回退 /tmp 并保持 0700（OP-10）。
SECRETS_TMP_DIR=${SECRETS_TMP_DIR:-/run/antifieldcloud/secrets-tmp}
opencode_warning=""

json_error() {
  printf '{"ok":false,"error":"%s"}\n' "$1"
  exit 1
}

if [[ "$(id -u)" -ne 0 ]]; then
  json_error "需要 root 权限"
fi
if ! command -v age >/dev/null 2>&1; then
  json_error "age 未安装（apt-get install -y age 后重试）"
fi
if [[ ! -f "$RECIPIENT_FILE" ]]; then
  json_error "缺少 age 公钥文件：$RECIPIENT_FILE（age-keygen 生成后把 age1... 写入该文件）"
fi

# 公钥文件安全校验：必须 root 所有，且组/其他不可写（防止被篡改后加密到攻击者密钥）。
key_mode=$(stat -c '%a' "$RECIPIENT_FILE")
key_owner=$(stat -c '%u' "$RECIPIENT_FILE")
if [[ "$key_owner" -ne 0 ]]; then
  json_error "age 公钥文件必须由 root 所有：$RECIPIENT_FILE"
fi
if (( (8#$key_mode & 8#022) != 0 )); then
  json_error "age 公钥文件权限过宽（$key_mode），要求组/其他不可写：$RECIPIENT_FILE"
fi
RECIPIENT=$(head -n 1 "$RECIPIENT_FILE" | tr -d '\r\n')
if [[ ! "$RECIPIENT" =~ ^age1[0-9a-z]{16,}$ ]]; then
  json_error "age 公钥格式无效：$RECIPIENT_FILE"
fi

umask 027
mkdir -p "$BACKUP_DIR"
if getent group "$GROUP" >/dev/null 2>&1; then
  chgrp "$GROUP" "$BACKUP_DIR" 2>/dev/null || true
fi
chmod 2750 "$BACKUP_DIR" 2>/dev/null || chmod 0750 "$BACKUP_DIR"

# 所有明文只允许出现在 0700 临时目录；任何退出路径都清理，失败不留下未加密产物。
# 优先使用 tmpfs（/run/antifieldcloud），避免明文短暂落盘；启动前清理上次残留。
tmp_parent="$SECRETS_TMP_DIR"
if ! mkdir -p "$tmp_parent" 2>/dev/null; then
  tmp_parent="${TMPDIR:-/tmp}/antifieldcloud-secrets-tmp"
  mkdir -p "$tmp_parent"
fi
chmod 0700 "$tmp_parent"
find "$tmp_parent" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
# opencode 快照需要以 opencode 用户写入，且其父目录必须可被 opencode 用户遍历：
# tmp_parent/work 都是 0700 root，直接在其下创建快照目录会阻断 opencode 的路径遍历。
# 因此单独使用 0711 父目录（其他用户可进入但不可列目录），快照子目录 0700 归 opencode。
snapshot_parent="${tmp_parent%/}-opencode"
if ! mkdir -p "$snapshot_parent" 2>/dev/null; then
  snapshot_parent="${TMPDIR:-/tmp}/antifieldcloud-secrets-opencode"
  mkdir -p "$snapshot_parent"
fi
chmod 0711 "$snapshot_parent"
find "$snapshot_parent" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
work=$(mktemp -d "$tmp_parent/work.XXXXXX")
chmod 0700 "$work"
snapshot_root=""
archive=""
tmp_tar="$work/secrets.tar.gz"
cleanup() {
  rm -rf "$work"
  if [[ -n "$snapshot_root" ]]; then rm -rf "$snapshot_root"; fi
  if [[ -n "${snapshot_parent:-}" ]]; then rmdir "$snapshot_parent" 2>/dev/null || true; fi
  if [[ -n "$archive" && -e "$archive" && -z "${archive_committed:-}" ]]; then
    rm -f "$archive" "$archive.sha256"
  fi
}
trap cleanup EXIT

stamp=$(date -u +%Y%m%dT%H%M%SZ)
name="secrets-${stamp}.tar.age"
archive="$BACKUP_DIR/$name"
sha_file="$archive.sha256"

# opencode 用户执行固定 node:sqlite 快照命令（不用 shell 拼接用户输入）。
run_as_opencode() {
  if command -v runuser >/dev/null 2>&1; then
    runuser -u opencode -- "$@"
  else
    sudo -n -u opencode -H "$@"
  fi
}

# 汇总要加密的根文件；env 必须存在，其它缺失时跳过并计数。
root_files=()
for candidate in \
  /etc/antifieldcloud/env \
  /etc/cloudflared/config.yml \
  /etc/cloudflared/cert.pem \
  /etc/opencode/opencode.env \
  /home/antifield/minecraft-server/server.properties \
  "$OPENCODE_CONFIG_DIR/opencode.json" \
  "$OPENCODE_CONFIG_DIR/service.json"; do
  if [[ -f "$candidate" ]]; then
    root_files+=("${candidate#/}")
  fi
done
for candidate in /etc/cloudflared/*.json; do
  if [[ -f "$candidate" ]]; then
    root_files+=("${candidate#/}")
  fi
done
if [[ ! -f /etc/antifieldcloud/env ]]; then
  json_error "缺少 /etc/antifieldcloud/env，无法做密钥备份"
fi
if [[ ${#root_files[@]} -eq 0 ]]; then
  json_error "没有可备份的密钥文件"
fi

# opencode 数据库一致性快照：以 opencode 用户执行固定 node:sqlite backup，不修改 opencode 服务。
# 生产密钥包要求包含 opencode DB：目录不可写或快照失败时直接失败退出，由调用方把密钥包状态置为失败，
# 避免只记 warning、PC 侧 secretsOk 仍为 true 的静默漏备（失败会保留 Pi 上既有密钥包，下次重试）。
opencode_included=false
if [[ -f "$OPENCODE_DB" ]] && getent passwd opencode >/dev/null 2>&1 && [[ -x "$NODE_BIN" ]]; then
  snapshot_root=$(mktemp -d "$snapshot_parent/opencode.XXXXXX")
  snapshot_dir="$snapshot_root/opencode"
  mkdir -p "$snapshot_dir"
  chown opencode:opencode "$snapshot_root" "$snapshot_dir"
  chmod 0700 "$snapshot_root" "$snapshot_dir"
  snapshot_db="$snapshot_dir/opencode.db"
  if ! run_as_opencode sh -c 'test -w "$0"' "$snapshot_dir" >/dev/null 2>&1; then
    json_error "opencode 快照目录不可写（opencode 用户无法访问临时目录）"
  fi
  # node:sqlite 的 backup() 对运行中的 WAL 库做一致性快照；命令固定、无用户输入拼接。
  if ! run_as_opencode env SOURCE_OC_DB="$OPENCODE_DB" TARGET_OC_DB="$snapshot_db" "$NODE_BIN" --input-type=module -e '
    import { DatabaseSync, backup } from "node:sqlite"
    const source = new DatabaseSync(process.env.SOURCE_OC_DB, { readOnly: true })
    try {
      await backup(source, process.env.TARGET_OC_DB)
    } finally {
      source.close()
    }
  ' >/dev/null 2>&1; then
    json_error "opencode 数据库一致性快照失败（密钥包未生成；请检查 opencode 用户/数据库权限）"
  fi
  chmod 0600 "$snapshot_db" 2>/dev/null || true
  opencode_included=true
fi

if [[ "$opencode_included" == "true" ]]; then
  tar -czf "$tmp_tar" -C / "${root_files[@]}" -C "$snapshot_root" opencode
else
  tar -czf "$tmp_tar" -C / "${root_files[@]}"
fi

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
archive_committed=1

# 保留最近 KEEP 份（含本次），删除更旧的归档与旁文件；清理无 .age 对应的 .sha256 孤儿。
mapfile -t stale < <(find "$BACKUP_DIR" -maxdepth 1 -name 'secrets-*.tar.age' -printf '%f\n' | sort -r | tail -n +$((KEEP + 1)))
for old in "${stale[@]}"; do
  rm -f "$BACKUP_DIR/$old" "$BACKUP_DIR/$old.sha256"
done
while IFS= read -r orphan_sha; do
  [[ -n "$orphan_sha" ]] || continue
  [[ -f "${orphan_sha%.sha256}" ]] || rm -f "$orphan_sha"
done < <(find "$BACKUP_DIR" -maxdepth 1 -name 'secrets-*.tar.age.sha256' -print)

size=$(stat -c '%s' "$archive")
created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
extra_files=0
if [[ "$opencode_included" == "true" ]]; then
  extra_files=1
fi
file_count=$(( ${#root_files[@]} + extra_files ))
warnings_json="[]"
if [[ -n "$opencode_warning" ]]; then
  warnings_json="[\"$opencode_warning\"]"
fi
printf '{"ok":true,"archive":"%s","archiveName":"%s","sha256":"%s","sizeBytes":%s,"fileCount":%s,"includesOpencode":%s,"createdAt":"%s","keep":%s,"warnings":%s}\n' \
  "$archive" "$name" "$sha256" "$size" "$file_count" "$opencode_included" "$created_at" "$KEEP" "$warnings_json"

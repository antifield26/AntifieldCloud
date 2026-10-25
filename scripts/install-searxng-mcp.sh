#!/usr/bin/env bash
# 将 SearXNG MCP 搜索工具接入 OpenCode v2（不重启 Minecraft，仅重启 opencode）。
# 目标：Bot Chat 只能调用 searxng_web_search；其余工具在 Bot 会话权限中仍 deny。
# 幂等：覆盖 /opt/searxng-mcp/searxng-mcp.mjs 与 mcp.servers.searxng 条目；保留其它配置。
set -euo pipefail

SRC="$(dirname "$0")/searxng-mcp.mjs"
DEST_DIR=/opt/searxng-mcp
DEST="$DEST_DIR/searxng-mcp.mjs"
CONFIG=/var/lib/opencode/.config/opencode/opencode.json

if [ "$(id -u)" -ne 0 ]; then
  echo "请以 root 运行（sudo）" >&2
  exit 1
fi
if [ ! -f "$SRC" ]; then
  echo "缺少 MCP 服务脚本：$SRC" >&2
  exit 1
fi
if [ ! -f "$CONFIG" ]; then
  echo "缺少 OpenCode 配置：$CONFIG（先安装 OpenCode v2）" >&2
  exit 1
fi

install -d -o root -g root -m 0755 "$DEST_DIR"
install -o root -g root -m 0755 "$SRC" "$DEST"

# 先备份 OpenCode 配置：写入采用“临时文件 + os.replace”原子替换（OPS-16）。
backup="$CONFIG.bak.$(date -u +%Y%m%dT%H%M%SZ)"
cp -a "$CONFIG" "$backup"
chmod 0640 "$backup" 2>/dev/null || true
echo "已备份 OpenCode 配置：$backup"

python3 - "$CONFIG" <<'PY'
import json
import os
import sys
import tempfile

path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    config = json.load(handle)
mcp = config.setdefault("mcp", {})
servers = mcp.setdefault("servers", {})
servers["searxng"] = {
    "type": "local",
    "command": ["/usr/local/bin/node", "/opt/searxng-mcp/searxng-mcp.mjs"],
    "environment": {
        "SEARXNG_URL": "http://127.0.0.1:8888",
        "SEARXNG_ENGINES": "bing",
    },
    # 直接暴露 searxng_web_search；Bot 会话权限可精确允许该工具而不放行 Code Mode。
    "codemode": False,
}
dir_name = os.path.dirname(path) or "."
fd, tmp_path = tempfile.mkstemp(prefix=".opencode-json-", suffix=".tmp", dir=dir_name)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(config, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(tmp_path, 0o640)
    os.replace(tmp_path, path)
finally:
    if os.path.exists(tmp_path):
        os.unlink(tmp_path)
PY
# 该文件由 root 原子替换；OpenCode 以 opencode 用户读取，必须恢复属主/权限（否则 MCP 配置被静默忽略）。
chown opencode:opencode "$CONFIG"
chmod 0640 "$CONFIG"

if systemctl list-unit-files opencode.service >/dev/null 2>&1; then
  systemctl restart opencode
  sleep 3
  systemctl is-active opencode
fi
echo "SearXNG MCP 已安装：$DEST；OpenCode 配置已更新：$CONFIG"
echo "应用侧仍需 BOT_SEARCH_ENABLED=true/BOT_SEARCH_MODE=mcp 并重启 antifieldcloud。"

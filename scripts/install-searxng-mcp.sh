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

python3 - "$CONFIG" <<'PY'
import json
import sys

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
with open(path, "w", encoding="utf-8") as handle:
    json.dump(config, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY

if systemctl list-unit-files opencode.service >/dev/null 2>&1; then
  systemctl restart opencode
  sleep 3
  systemctl is-active opencode
fi
echo "SearXNG MCP 已安装：$DEST；OpenCode 配置已更新：$CONFIG"
echo "应用侧仍需 BOT_SEARCH_ENABLED=true/BOT_SEARCH_MODE=mcp 并重启 antifieldcloud。"

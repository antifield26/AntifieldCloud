#!/usr/bin/env bash
# 将 Bot 消息发送 MCP 工具接入 OpenCode v2（不重启 Minecraft，仅重启 opencode）。
# 目标：Bot 会话可调用 botmsg_send_message；应用侧用 BOT_SECRET_KEY 派生的 turn_token 校验。
# 幂等：覆盖 /opt/botmsg-mcp/botmsg-mcp.mjs 与 mcp.servers.botmsg 条目；保留其它配置。
set -euo pipefail

SRC="$(dirname "$0")/bot-tool-mcp.mjs"
DEST_DIR=/opt/botmsg-mcp
DEST="$DEST_DIR/bot-tool-mcp.mjs"
CONFIG=/var/lib/opencode/.config/opencode/opencode.json
TOOL_URL="${BOT_TOOL_URL:-http://127.0.0.1:3000/api/bot/ai/tool/send}"

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

# 先备份 OpenCode 配置：写入采用“临时文件 + os.replace”原子替换，失败不会留下半截 JSON（OPS-16）。
backup="$CONFIG.bak.$(date -u +%Y%m%dT%H%M%SZ)"
cp -a "$CONFIG" "$backup"
chmod 0640 "$backup" 2>/dev/null || true
echo "已备份 OpenCode 配置：$backup"

python3 - "$CONFIG" "$TOOL_URL" <<'PY'
import json
import os
import sys
import tempfile

path = sys.argv[1]
tool_url = sys.argv[2]
with open(path, encoding="utf-8") as handle:
    config = json.load(handle)
mcp = config.setdefault("mcp", {})
servers = mcp.setdefault("servers", {})
servers["botmsg"] = {
    "type": "local",
    "command": ["/usr/local/bin/node", "/opt/botmsg-mcp/bot-tool-mcp.mjs"],
    "environment": {"BOT_TOOL_URL": tool_url},
    # 直接暴露 botmsg_send_message；Bot 会话权限允许 botmsg_*，其余工具仍 deny。
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
  # 版本粗检：只确认 opencode 可执行且能输出版本（详细契约验证见 docs/DEPLOY.md §3.2）。
  opencode_bin=/var/lib/opencode/.opencode/bin/opencode
  if [ -x "$opencode_bin" ]; then
    ( cd /var/lib/opencode && runuser -u opencode -- env HOME=/var/lib/opencode "$opencode_bin" --version ) || {
      echo "警告：opencode --version 失败；请检查 OpenCode 安装" >&2
    }
  else
    echo "警告：未找到 $opencode_bin，跳过版本检查" >&2
  fi
fi
echo "Bot 消息发送 MCP 已安装：$DEST；OpenCode 配置已更新：$CONFIG"
echo "应用侧需设置 BOT_AI_SEND_TOOL_ENABLED=true 并重启 antifieldcloud。"

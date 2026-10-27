#!/usr/bin/env bash
# SearXNG 私有实例安装/更新（Debian 13，Node 项目外；不使用 Docker）。
# 仅监听 127.0.0.1:8888，供 AntifieldComplexx Chatbot 的 JSON 搜索使用；应用侧只读。
# 幂等：已存在的 /etc/searxng/settings.yml 不会被覆盖；git 仓库/venv 缺失时才创建。
set -euo pipefail

INSTALL_DIR=/opt/searxng
VENV_DIR=/opt/searxng-venv
SETTINGS_DIR=/etc/searxng
SETTINGS_FILE=${SETTINGS_DIR}/settings.yml
STATE_DIR=/var/lib/searxng
SERVICE_FILE=/etc/systemd/system/searxng.service
BIND=127.0.0.1:8888
REPO_URL=https://github.com/searxng/searxng.git

if [ "$(id -u)" -ne 0 ]; then
  echo "请以 root 运行（sudo）" >&2
  exit 1
fi

if ! python3 -m venv --help >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq python3-venv
fi

if ! id searxng >/dev/null 2>&1; then
  useradd --system --home-dir "$STATE_DIR" --shell /usr/sbin/nologin --no-create-home searxng
fi
install -d -o searxng -g searxng -m 0750 "$STATE_DIR"
install -d -o root -g searxng -m 0750 "$SETTINGS_DIR"
git config --global --add safe.directory "$INSTALL_DIR" 2>/dev/null || true

if [ ! -d "$INSTALL_DIR/.git" ]; then
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
else
  git -C "$INSTALL_DIR" fetch --depth 1 origin
  git -C "$INSTALL_DIR" reset --hard origin/HEAD
fi
chown -R root:root "$INSTALL_DIR"
# 记录实际部署的 commit：SearXNG 未固定 tag，升级后靠这里追溯（OPS-16 供应链可审计性）。
deployed_commit=$(git -C "$INSTALL_DIR" rev-parse HEAD)
printf '%s\n' "$deployed_commit" > "$SETTINGS_DIR/deployed-commit"
chown root:searxng "$SETTINGS_DIR/deployed-commit"
chmod 0640 "$SETTINGS_DIR/deployed-commit"
echo "SearXNG commit：$deployed_commit"

if [ ! -x "$VENV_DIR/bin/python" ]; then
  python3 -m venv "$VENV_DIR"
fi
"$VENV_DIR/bin/pip" install -q -U pip setuptools wheel
"$VENV_DIR/bin/pip" install -q -r "$INSTALL_DIR/requirements.txt"
"$VENV_DIR/bin/pip" install -q gunicorn
# 冻结实际安装依赖，便于事后审计/重建（不强制下次安装使用；升级需人工评审）。
"$VENV_DIR/bin/pip" freeze > "$VENV_DIR/requirements.lock"

if [ ! -f "$SETTINGS_FILE" ]; then
  secret=$(openssl rand -hex 32)
  template="$(dirname "$0")/../deploy/searxng/settings.yml.example"
  if [ ! -f "$template" ]; then
    echo "缺少配置模板：$template" >&2
    exit 1
  fi
  sed "s/__SEARXNG_SECRET__/$secret/" "$template" >"$SETTINGS_FILE"
  chown root:searxng "$SETTINGS_FILE"
  chmod 0640 "$SETTINGS_FILE"
fi

install -m 0644 "$(dirname "$0")/../deploy/systemd/searxng.service" "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable searxng >/dev/null
systemctl restart searxng

for _ in $(seq 1 20); do
  if curl -fsS --max-time 2 "http://$BIND/config" >/dev/null 2>&1; then
    echo "SearXNG 已启动：http://$BIND/config"
    exit 0
  fi
  sleep 1
done
echo "SearXNG 启动失败；查看：journalctl -u searxng -n 80 --no-pager" >&2
exit 1

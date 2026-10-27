#!/bin/sh
# AntifieldComplexx 主机健康探针（root，由 antifieldcloud-health.timer 每 60s 调用一次）：
# 采集 vcgencmd 欠压/降频/温度与风扇转速，原子写入 /run/antifieldcloud/pi-health.json。
# 应用侧（alerts 模块）只读该 JSON 做告警；探针失败不应影响主服务。
set -eu

OUT_DIR=${PI_HEALTH_DIR:-/run/antifieldcloud}
OUT_FILE="$OUT_DIR/pi-health.json"
mkdir -p "$OUT_DIR"

read_throttled() {
  vcgencmd get_throttled 2>/dev/null || echo 'throttled=0x0'
}

throttled_out=$(read_throttled)
throttled=${throttled_out#throttled=}
case "$throttled" in
  0x*|0X*) ;;
  *) throttled=0x0 ;;
esac
mask=$((throttled))

temp_raw=$(vcgencmd measure_temp 2>/dev/null || echo "temp=0'C")
temp=${temp_raw#temp=}
temp=${temp%\'C}
case "$temp" in
  ''|*[!0-9.]*) temp=0 ;;
esac

fan=-1
for candidate in /sys/class/thermal/cooling_device*/cur_state; do
  if [ -r "$candidate" ]; then
    fan=$(cat "$candidate" 2>/dev/null || echo -1)
    break
  fi
done
case "$fan" in
  ''|*[!0-9-]*) fan=-1 ;;
esac

bool() {
  if [ "$1" -ne 0 ]; then printf 'true'; else printf 'false'; fi
}

uv_now=$(bool $((mask & 1)))
uv_occurred=$(bool $(((mask >> 16) & 1)))
freq_now=$(bool $(((mask >> 1) & 1)))
freq_occurred=$(bool $(((mask >> 17) & 1)))
throttle_now=$(bool $(((mask >> 2) & 1)))
throttle_occurred=$(bool $(((mask >> 18) & 1)))
soft_now=$(bool $(((mask >> 3) & 1)))
soft_occurred=$(bool $(((mask >> 19) & 1)))

now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
epoch=$(date +%s)
tmp="$OUT_FILE.tmp.$$"
cat > "$tmp" <<EOF
{"generatedAt":"$now","epoch":$epoch,"throttled":"0x$(printf '%x' "$mask")","underVoltage":$uv_now,"undervoltageNow":$uv_now,"undervoltageOccurred":$uv_occurred,"freqCappedNow":$freq_now,"freqCappedOccurred":$freq_occurred,"throttledNow":$throttle_now,"throttledOccurred":$throttle_occurred,"softTempLimitNow":$soft_now,"softTempLimitOccurred":$soft_occurred,"tempC":$temp,"fan":$fan}
EOF
chmod 0644 "$tmp"
mv -f "$tmp" "$OUT_FILE"

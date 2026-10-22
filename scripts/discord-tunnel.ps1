# AntifieldCloud Bot 出站代理隧道（Windows 用户级）
# 将 Pi 的 127.0.0.1:18090 反向转发到 PC 的 127.0.0.1:10090；仅 loopback。
# 先探测 PC 代理端口，再建立 SSH 反向隧道；SSH 退出或代理不可用时循环重试，不静默退出。
param(
  [string]$PiHost = $(if ($env:ANTIFIELD_PI_HOST) { $env:ANTIFIELD_PI_HOST } else { '169.254.77.10' }),
  [int]$ProxyPort = 10090,
  [int]$TunnelPort = 18090
)

$ErrorActionPreference = 'Continue'
$ssh = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
$logDir = Join-Path $env:LOCALAPPDATA 'AntifieldCloud'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'discord-tunnel.log'

function Write-Log([string]$message) {
  try {
    if ((Test-Path $log) -and (Get-Item $log).Length -gt 1MB) {
      Move-Item -Force $log "$log.old"
    }
    Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format o), $message)
  } catch {
    # 日志失败不影响隧道重试。
  }
}

function Test-ProxyPort {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync('127.0.0.1', $ProxyPort)
    if (-not $task.Wait(2000)) { return $false }
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

while ($true) {
  if (-not (Test-ProxyPort)) {
    Write-Log ("proxy 127.0.0.1:{0} unavailable; retry in 10s" -f $ProxyPort)
    Start-Sleep -Seconds 10
    continue
  }
  Write-Log ("tunnel starting {0}:{1} -> 127.0.0.1:{2} (host {3})" -f $TunnelPort, $ProxyPort, $ProxyPort, $PiHost)
  & $ssh -N -o ExitOnForwardFailure=yes -o ConnectTimeout=10 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 `
    -o StrictHostKeyChecking=accept-new -R ("127.0.0.1:{0}:127.0.0.1:{1}" -f $TunnelPort, $ProxyPort) `
    ("antifield@{0}" -f $PiHost) 2>&1 | Add-Content -Path $log
  Write-Log 'ssh exited; restart in 5s'
  Start-Sleep -Seconds 5
}

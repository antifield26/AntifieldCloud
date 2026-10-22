# AntifieldCloud Bot 出站代理隧道（Windows 用户级）
# 将 Pi 的 127.0.0.1:18090 反向转发到 PC 的 127.0.0.1:10090；仅 loopback。
# 默认静默后台运行：直接运行本脚本会通过 discord-tunnel.vbs 以无窗口方式启动自身；
# 调试时显式加 -Foreground，脚本才会占用当前 shell。计划任务由 install-tunnel-task.ps1 安装。
param(
  [string]$PiHost = $(if ($env:ANTIFIELD_PI_HOST) { $env:ANTIFIELD_PI_HOST } else { '169.254.77.10' }),
  [int]$ProxyPort = 10090,
  [int]$TunnelPort = 18090,
  [switch]$Foreground,
  # 由 VBS/隐藏启动器传入，避免再次自我启动；正常用户无需指定。
  [switch]$Internal
)

$ErrorActionPreference = 'Continue'

function Start-HiddenSelf {
  $vbs = Join-Path $PSScriptRoot 'discord-tunnel.vbs'
  $wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
  if ((Test-Path $vbs) -and (Test-Path $wscript)) {
    Start-Process -FilePath $wscript -ArgumentList @('//B', '//Nologo', "`"$vbs`"") -WindowStyle Hidden
    return $true
  }
  $powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (-not (Test-Path $powershell)) { return $false }
  $arguments = @(
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Internal'
  )
  Start-Process -FilePath $powershell -ArgumentList $arguments -WindowStyle Hidden
  return $true
}

if (-not $Foreground -and -not $Internal) {
  # 交互运行时立即脱离当前 shell，不占用前台；加 -Foreground 可前台调试。
  if (Start-HiddenSelf) { exit 0 }
}

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

$mutex = New-Object System.Threading.Mutex($false, 'Local\AntifieldCloudDiscordTunnel')
if (-not $mutex.WaitOne(0)) {
  Write-Log 'another tunnel instance is running; exit'
  exit 0
}

try {
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
} finally {
  try {
    $mutex.ReleaseMutex()
  } catch {
    # 进程退出时互斥量会由系统释放；这里忽略释放异常。
  }
  $mutex.Dispose()
}

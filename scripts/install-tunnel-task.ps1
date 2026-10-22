# 安装/更新 Windows 用户级 Bot 代理隧道任务：登录时启动，异常退出自动重启。
# 同时刷新 %LOCALAPPDATA%\AntifieldCloud\discord-tunnel.ps1；不需要管理员权限。
param(
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$taskName = 'AntifieldCloudDiscordTunnel'
if ($Remove) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "已移除计划任务 $taskName"
  exit 0
}

$localDir = Join-Path $env:LOCALAPPDATA 'AntifieldCloud'
New-Item -ItemType Directory -Force -Path $localDir | Out-Null
$source = Join-Path $PSScriptRoot 'discord-tunnel.ps1'
if (-not (Test-Path $source)) { throw "找不到源脚本：$source" }
Copy-Item -Path $source -Destination (Join-Path $localDir 'discord-tunnel.ps1') -Force

$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action = New-ScheduledTaskAction -Execute $powershell -Argument (
  '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $localDir 'discord-tunnel.ps1')
)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host "已安装计划任务 $taskName；日志：$localDir\discord-tunnel.log"

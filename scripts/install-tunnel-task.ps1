# 安装/更新 Windows 用户级 Bot 代理隧道任务：登录时启动，异常退出自动重启。
# 通过 wscript + VBS 无窗口启动，避免占用前台 shell；同时刷新
# %LOCALAPPDATA%\AntifieldCloud\discord-tunnel.ps1 与 discord-tunnel.vbs；不需要管理员权限。
param(
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$taskName = 'AntifieldCloudDiscordTunnel'

function Stop-ExistingTunnel {
  # 只匹配真正的隧道进程，避免误杀命令行里提到 discord-tunnel 的其它 PowerShell。
  $processes = Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq 'wscript.exe' -and $_.CommandLine -match 'discord-tunnel\.vbs') -or
    ($_.Name -eq 'powershell.exe' -and $_.CommandLine -match '-File\s+"?[^"]*discord-tunnel\.ps1') -or
    ($_.Name -eq 'ssh.exe' -and $_.CommandLine -match '-R\s+127\.0\.0\.1:18090:')
  }
  foreach ($process in $processes) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
}

if ($Remove) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Stop-ExistingTunnel
  Write-Host "已移除计划任务 $taskName"
  exit 0
}

$localDir = Join-Path $env:LOCALAPPDATA 'AntifieldCloud'
New-Item -ItemType Directory -Force -Path $localDir | Out-Null
$source = Join-Path $PSScriptRoot 'discord-tunnel.ps1'
$vbsSource = Join-Path $PSScriptRoot 'discord-tunnel.vbs'
if (-not (Test-Path $source)) { throw "找不到源脚本：$source" }
if (-not (Test-Path $vbsSource)) { throw "找不到静默启动器：$vbsSource" }
Copy-Item -Path $source -Destination (Join-Path $localDir 'discord-tunnel.ps1') -Force
Copy-Item -Path $vbsSource -Destination (Join-Path $localDir 'discord-tunnel.vbs') -Force

# 更新任务前先停掉旧实例，避免两个 SSH 反向隧道同时占用 18090。
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Stop-ExistingTunnel
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$action = New-ScheduledTaskAction -Execute $wscript -Argument (
  '//B //Nologo "{0}"' -f (Join-Path $localDir 'discord-tunnel.vbs')
)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -Hidden
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host "已安装静默计划任务 $taskName；日志：$localDir\discord-tunnel.log"
Write-Host "调试前台：powershell -NoProfile -ExecutionPolicy Bypass -File `"$localDir\discord-tunnel.ps1`" -Foreground"

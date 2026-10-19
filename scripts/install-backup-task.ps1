param(
  [string]$PiHost = "192.0.2.10",
  [string]$PiUser = "antifield",
  [string]$DailyTime = "12:00",
  [string]$BackupRoot = (Join-Path $env:USERPROFILE "AntifieldCloudBackups")
)

# 安装/更新当前用户的每日备份任务（需要管理员权限；旧任务 PiBackUp-Nightly 不动）。
# -BackupRoot 传给计划任务里的 backup-pull.ps1，默认 %USERPROFILE%\AntifieldCloudBackups。
$ErrorActionPreference = "Stop"
$base = Join-Path $env:LOCALAPPDATA "AntifieldCloud"
New-Item -ItemType Directory -Force -Path $base | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $BackupRoot "daily"), (Join-Path $BackupRoot "weekly") | Out-Null

$source = Join-Path $PSScriptRoot "backup-pull.ps1"
if (-not (Test-Path $source)) { throw "找不到 $source" }
Copy-Item -Force $source (Join-Path $base "backup-pull.ps1")

$script = Join-Path $base "backup-pull.ps1"
$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -BackupRoot `"$BackupRoot`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
$daily = New-ScheduledTaskTrigger -Daily -At $DailyTime
$logon = New-ScheduledTaskTrigger -AtLogOn
$logon.Delay = "PT10M"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

try {
  Register-ScheduledTask `
    -TaskName "AntifieldCloud-Backup-Pull" `
    -Description "AntifieldCloud 每日备份：从 Pi 拉取增量/全量归档到 $BackupRoot" `
    -Action $action `
    -Trigger @($daily, $logon) `
    -Settings $settings `
    -Principal $principal `
    -Force `
    -ErrorAction Stop | Out-Null
} catch {
  throw "注册计划任务失败：$($_.Exception.Message)`n请以【管理员身份】打开 PowerShell 后重新运行本脚本。"
}

$task = Get-ScheduledTask -TaskName "AntifieldCloud-Backup-Pull"
$info = Get-ScheduledTaskInfo -TaskName "AntifieldCloud-Backup-Pull"
Write-Host "已注册计划任务：$($task.TaskName)（状态：$($task.State)）"
Write-Host "每日运行时间：$DailyTime"
Write-Host "下次运行：$($info.NextRunTime)"
Write-Host "日志：$base\backup.log"
Write-Host "目标：$BackupRoot"
Write-Host "旧任务 PiBackUp-Nightly 未被修改。"

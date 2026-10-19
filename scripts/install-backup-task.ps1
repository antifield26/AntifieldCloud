param(
  [string]$PiHost = "192.0.2.10",
  [string]$PiUser = "antifield",
  [string]$DailyTime = "12:00",
  [string]$BackupRoot = (Join-Path $env:USERPROFILE "AntifieldCloudBackups"),
  [switch]$DryRun
)

# 安装/更新当前用户的每日备份任务，并收紧备份目录 ACL（仅当前用户 + Administrators + SYSTEM）。
# - 任务参数显式传入 -PiHost/-PiUser/-BackupRoot，避免使用脚本默认占位值导致备份指向错误主机。
# - 任务在电池供电时也运行（AllowStartIfOnBatteries/DontStopIfGoingOnBatteries）。
# - 旧任务 PiBackUp-Nightly 保持原样，不修改。
# -DryRun 只打印将要执行的配置，不注册任务、不改 ACL，便于审阅/CI。
$ErrorActionPreference = "Stop"
$base = Join-Path $env:LOCALAPPDATA "AntifieldCloud"
$source = Join-Path $PSScriptRoot "backup-pull.ps1"
if (-not (Test-Path $source)) { throw "找不到 $source" }

function Test-PiReachable {
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      if (Test-NetConnection -ComputerName $PiHost -Port 22 -InformationLevel Quiet -WarningAction SilentlyContinue) { return $true }
    } catch {
      # 网络抖动继续重试。
    }
    if ($attempt -lt 3) { Start-Sleep -Seconds 2 }
  }
  return $false
}

# 用 SID 收紧 ACL，避免中文/英文本地化组名差异；/reset 让子项继承目录的新 ACL。
function Set-BackupAcl {
  param([string]$Path, [switch]$WhatIfOnly)
  $userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $grants = @(
    "*${userSid}:(OI)(CI)F",
    "*S-1-5-32-544:(OI)(CI)F",
    "*S-1-5-18:(OI)(CI)F"
  )
  $rootArgs = @($Path, "/inheritance:r", "/grant:r") + $grants
  $childArgs = @("$Path\*", "/T", "/Q", "/C", "/reset")
  if ($WhatIfOnly) {
    Write-Host "icacls $($rootArgs -join ' ')"
    Write-Host "icacls $($childArgs -join ' ')"
    return
  }
  & icacls.exe @rootArgs | Out-Null
  & icacls.exe @childArgs | Out-Null
  $acl = Get-Acl -Path $Path
  $forbidden = @("S-1-5-11", "S-1-5-32-545")
  foreach ($entry in $acl.Access) {
    $sid = $null
    try { $sid = $entry.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $sid = $null }
    if ($sid -and ($forbidden -contains $sid)) {
      throw "备份目录 ACL 仍包含不安全主体（$($entry.IdentityReference)），请以管理员身份重试"
    }
  }
}

if ($DryRun) {
  Write-Host "[DryRun] PiHost=$PiHost PiUser=$PiUser BackupRoot=$BackupRoot DailyTime=$DailyTime"
  Set-BackupAcl -Path $BackupRoot -WhatIfOnly
  exit 0
}

# 安装前预检：Pi 不可达时不修改本机脚本/ACL/任务。
if (-not (Test-PiReachable)) {
  throw "安装前预检失败：$PiHost:22 不可达。请确认直连网线、Pi 地址与 SSH 公钥后重试（未做任何修改）。"
}

New-Item -ItemType Directory -Force -Path $base | Out-Null
New-Item -ItemType Directory -Force -Path $BackupRoot, (Join-Path $BackupRoot "daily"), (Join-Path $BackupRoot "weekly"), (Join-Path $BackupRoot "secrets") | Out-Null
Copy-Item -Force $source (Join-Path $base "backup-pull.ps1")
Set-BackupAcl -Path $BackupRoot

$script = Join-Path $base "backup-pull.ps1"
$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -PiHost `"$PiHost`" -PiUser `"$PiUser`" -BackupRoot `"$BackupRoot`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
$daily = New-ScheduledTaskTrigger -Daily -At $DailyTime
$logon = New-ScheduledTaskTrigger -AtLogOn
$logon.Delay = "PT10M"
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

try {
  Register-ScheduledTask `
    -TaskName "AntifieldCloud-Backup-Pull" `
    -Description "AntifieldCloud 每日备份：从 $PiHost 拉取增量/全量归档到 $BackupRoot" `
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
Write-Host "Pi：$PiUser@$PiHost"
Write-Host "每日运行时间：$DailyTime（电池供电时不跳过；登录后 10 分钟补跑）"
Write-Host "下次运行：$($info.NextRunTime)"
Write-Host "日志：$base\backup.log（超过 1 MiB 自动轮转）"
Write-Host "目标：$BackupRoot（ACL 已收紧为当前用户 + Administrators + SYSTEM）"
Write-Host "旧任务 PiBackUp-Nightly 未被修改。"
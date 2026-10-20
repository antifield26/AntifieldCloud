param(
  [string]$PiHost = "192.0.2.10",
  [string]$PiUser = "antifield",
  [string]$DailyTime = "12:00",
  [string]$BackupRoot = (Join-Path $env:USERPROFILE "AntifieldCloudBackups"),
  [switch]$DryRun
)

# 安装/更新当前用户的每日备份任务，并收紧备份目录 ACL（仅当前用户 + Administrators + SYSTEM）。
# - 任务参数显式传入 -PiHost/-PiUser/-BackupRoot，避免使用脚本默认占位值导致备份指向错误主机；
# - 任务在电池供电时也运行（AllowStartIfOnBatteries/DontStopIfGoingOnBatteries）；
# - 旧任务 PiBackUp-Nightly 保持原样，不修改；
# - OP-17：icacls 返回码逐个检查、枚举全部 ACE 做主体白名单校验、写安装版本标记；
# - -DryRun 只打印将要执行的配置，不注册任务、不改 ACL。
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$base = Join-Path $env:LOCALAPPDATA "AntifieldCloud"
$source = Join-Path $PSScriptRoot "backup-pull.ps1"
$markerPath = Join-Path $base "backup-task.json"
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path $source)) { throw "找不到 $source" }

# 仓库版本（用于安装标记；读不到时用 unknown，不阻断安装）。
$packageVersion = "unknown"
try {
  $packageText = [System.IO.File]::ReadAllText((Join-Path $root "package.json"), [System.Text.Encoding]::UTF8)
  $parsedPackage = $packageText | ConvertFrom-Json
  if ($parsedPackage.version) { $packageVersion = [string]$parsedPackage.version }
} catch {
  Write-Warning "无法读取仓库 package.json 版本：$($_.Exception.Message)"
}

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
# OP-17：每个 icacls 调用的退出码都要检查；安装后枚举所有 ACE，任何非白名单主体都视为失败。
function Set-BackupAcl {
  param([string]$Path, [switch]$WhatIfOnly)
  $userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $allowedSids = @(
    $userSid,
    "S-1-5-32-544", # Administrators
    "S-1-5-18"      # SYSTEM
  )
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
    Write-Host "ACL 白名单：当前用户 + Administrators + SYSTEM"
    return
  }
  $rootResult = & icacls.exe @rootArgs 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "icacls 设置目录 ACL 失败（exit=$LASTEXITCODE）：$($rootResult -join ' ')"
  }
  $childResult = & icacls.exe @childArgs 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "icacls 重置子项 ACL 失败（exit=$LASTEXITCODE）：$($childResult -join ' ')"
  }
  $acl = Get-Acl -Path $Path
  $grantedCount = 0
  foreach ($entry in $acl.Access) {
    $sid = $null
    try { $sid = $entry.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $sid = $null }
    if (-not $sid) { throw "无法解析 ACL 主体 SID：$($entry.IdentityReference)" }
    if ($allowedSids -notcontains $sid) {
      throw "备份目录 ACL 包含非白名单主体（$($entry.IdentityReference) / $sid），请以管理员身份重试"
    }
    if ($entry.AccessControlType -ne "Allow") {
      throw "备份目录 ACL 含拒绝/非允许条目（$($entry.IdentityReference)）：$($entry.AccessControlType)"
    }
    if (($sid -eq $userSid) -or ($sid -eq "S-1-5-32-544") -or ($sid -eq "S-1-5-18")) {
      if (($entry.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
        throw "备份目录 ACL 权限不足（$($entry.IdentityReference)）：$($entry.FileSystemRights)"
      }
      $grantedCount++
    }
  }
  if ($grantedCount -lt 3) {
    throw "备份目录 ACL 缺少预期主体（仅找到 $grantedCount/3 个 FullControl 条目）"
  }
}

if ($DryRun) {
  Write-Host "[DryRun] PiHost=$PiHost PiUser=$PiUser BackupRoot=$BackupRoot DailyTime=$DailyTime"
  $dryArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $base 'backup-pull.ps1')`" -PiHost `"$PiHost`" -PiUser `"$PiUser`" -BackupRoot `"$BackupRoot`""
  Write-Host "[DryRun] 任务参数：$dryArguments"
  Set-BackupAcl -Path $BackupRoot -WhatIfOnly
  Write-Host "[DryRun] 版本标记将写入：$markerPath（version=$packageVersion）"
  exit 0
}

# 安装前预检：Pi 不可达时不修改本机脚本/ACL/任务。
if (-not (Test-PiReachable)) {
  throw "安装前预检失败：$PiHost:22 不可达。请确认直连网线、Pi 地址与 SSH 公钥后重试（未做任何修改）。"
}

New-Item -ItemType Directory -Force -Path $base | Out-Null
New-Item -ItemType Directory -Force -Path $BackupRoot, (Join-Path $BackupRoot "daily"), (Join-Path $BackupRoot "weekly"), (Join-Path $BackupRoot "secrets") | Out-Null
Copy-Item -Force $source (Join-Path $base "backup-pull.ps1")
$installedScriptPath = Join-Path $base "backup-pull.ps1"
$scriptSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $installedScriptPath).Hash.ToLower()
Set-BackupAcl -Path $BackupRoot

$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$installedScriptPath`" -PiHost `"$PiHost`" -PiUser `"$PiUser`" -BackupRoot `"$BackupRoot`""
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

# 读回校验：任务参数必须显式包含 -PiHost/-PiUser/-BackupRoot（避免引用默认占位值）。
$task = Get-ScheduledTask -TaskName "AntifieldCloud-Backup-Pull"
$registeredArguments = [string]$task.Actions[0].Arguments
foreach ($expected in @("-PiHost", "-PiUser", "-BackupRoot", $PiHost, $BackupRoot)) {
  if ($registeredArguments -notlike "*$expected*") {
    throw "计划任务参数校验失败：缺少 $expected（实际：$registeredArguments）"
  }
}

# 版本标记：记录安装时间、版本、脚本 SHA-256 与任务参数，便于排查“未重装”问题。
$marker = [ordered]@{
  installedAt      = (Get-Date).ToUniversalTime().ToString("o")
  appVersion       = $packageVersion
  taskName         = "AntifieldCloud-Backup-Pull"
  scriptPath       = $installedScriptPath
  scriptSha256     = $scriptSha
  piHost           = $PiHost
  piUser           = $PiUser
  backupRoot       = $BackupRoot
  dailyTime        = $DailyTime
  taskArguments    = $registeredArguments
}
$markerJson = ConvertTo-Json -InputObject $marker -Depth 5
[System.IO.File]::WriteAllText($markerPath, $markerJson + "`n", (New-Object System.Text.UTF8Encoding($false)))

$info = Get-ScheduledTaskInfo -TaskName "AntifieldCloud-Backup-Pull"
Write-Host "已注册计划任务：$($task.TaskName)（状态：$($task.State)）"
Write-Host "Pi：$PiUser@$PiHost"
Write-Host "每日运行时间：$DailyTime（电池供电时不跳过；登录后 10 分钟补跑）"
Write-Host "下次运行：$($info.NextRunTime)"
Write-Host "日志：$base\backup.log（超过 1 MiB 自动轮转）"
Write-Host "目标：$BackupRoot（ACL 已收紧为当前用户 + Administrators + SYSTEM）"
Write-Host "安装标记：$markerPath（version=$packageVersion，scriptSha256=$scriptSha）"
Write-Host "旧任务 PiBackUp-Nightly 未被修改。"

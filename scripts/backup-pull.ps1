param(
  [string]$PiHost = "192.0.2.10",
  [string]$PiUser = "antifield",
  [string]$BackupRoot = (Join-Path $env:USERPROFILE "AntifieldCloudBackups")
)

# 每天由 Windows 计划任务调用：让 Pi 生成增量/全量归档，拉取到 $BackupRoot。
# 依赖：直连网线可达 $PiHost；SSH 公钥已配置；Pi 上已部署 antifieldcloud 与备份 CLI。
$ErrorActionPreference = "Stop"
$target = "$PiUser@$PiHost"
$base = Join-Path $env:LOCALAPPDATA "AntifieldCloud"
$destRoot = $BackupRoot
$logPath = Join-Path $base "backup.log"
New-Item -ItemType Directory -Force -Path $base, (Join-Path $destRoot "daily"), (Join-Path $destRoot "weekly") | Out-Null

function Write-Log {
  param([string]$Message)
  $line = "{0} {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -Path $logPath -Value $line -Encoding UTF8
  Write-Host $line
}

function Test-PiReachable {
  try {
    return (Test-NetConnection -ComputerName $PiHost -Port 22 -InformationLevel Quiet -WarningAction SilentlyContinue)
  } catch {
    return $false
  }
}

function Invoke-PiSsh {
  param([string]$Command, [int]$Attempts = 2)
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    $output = & ssh.exe -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 $target $Command 2>&1
    if ($LASTEXITCODE -eq 0) { return $output }
    if ($attempt -eq $Attempts) {
      throw "ssh 失败（exit=$LASTEXITCODE）：$output"
    }
    Start-Sleep -Seconds 10
  }
}

function Copy-FromPi {
  param([string]$Remote, [string]$Local, [int]$Attempts = 2)
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    & scp.exe -o BatchMode=yes -o ConnectTimeout=10 "$target`:$Remote" $Local 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { return }
    if ($attempt -eq $Attempts) { throw "scp 失败（exit=$LASTEXITCODE）：$Remote" }
    Start-Sleep -Seconds 10
  }
}

function Copy-ToPi {
  param([string]$Local, [string]$Remote)
  & scp.exe -o BatchMode=yes -o ConnectTimeout=10 $Local "$target`:$Remote" 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "scp 上传失败（exit=$LASTEXITCODE）：$Local" }
}

function Invoke-Pull {
  if (-not (Test-PiReachable)) { throw "Pi 直连不可达（$PiHost:22），请检查网线/地址" }

  $isSunday = ((Get-Date).DayOfWeek -eq [System.DayOfWeek]::Sunday)
  $modeArg = if ($isSunday) { "--full" } else { "" }
  Write-Log "开始备份（mode=$(if ($isSunday) { 'full' } else { 'inc' })）"
  $remoteCommand = "sudo -u antifieldcloud -H /usr/local/bin/node /opt/antifieldcloud/current/scripts/backup.mjs $modeArg"
  $output = Invoke-PiSsh $remoteCommand
  $jsonLines = @($output | Where-Object { $_ -match '^\s*\{' })
  if ($jsonLines.Count -eq 0) { throw "备份脚本没有返回 JSON：$output" }
  $result = $jsonLines[$jsonLines.Count - 1] | ConvertFrom-Json
  if (-not $result.ok) { throw "备份失败：$($result.error)" }

  $archive = [string]$result.archive
  if (-not $archive.StartsWith("/var/lib/antifieldcloud/backups/")) { throw "归档路径不符合预期：$archive" }
  $archiveName = [string]$result.archiveName
  if ($archiveName -match '[\\/]') { throw "归档名异常：$archiveName" }

  $folder = if ($result.mode -eq "full") { "weekly" } else { "daily" }
  $dateDir = Join-Path (Join-Path $destRoot $folder) (Get-Date).ToString("yyyy-MM-dd")
  New-Item -ItemType Directory -Force -Path $dateDir | Out-Null
  $localPath = Join-Path $dateDir $archiveName
  Write-Log "拉取 $archiveName（$($result.sizeBytes) bytes）"
  Copy-FromPi $archive $localPath

  $actual = (Get-FileHash -Algorithm SHA256 -Path $localPath).Hash.ToLower()
  if ($actual -ne ([string]$result.sha256).ToLower()) {
    Remove-Item $localPath -Force -ErrorAction SilentlyContinue
    throw "SHA-256 校验失败：本地 $actual / 远端 $($result.sha256)"
  }

  $status = @{
    lastPullAt = (Get-Date).ToUniversalTime().ToString("o")
    sizeBytes  = [long]$result.sizeBytes
    ok         = $true
    archiveName = $archiveName
    mode       = [string]$result.mode
  } | ConvertTo-Json -Compress
  $tmp = Join-Path $env:TEMP "antifieldcloud-pull.json"
  [System.IO.File]::WriteAllText($tmp, $status, (New-Object System.Text.UTF8Encoding($false)))
  Copy-ToPi $tmp "/tmp/antifieldcloud-pull.json"
  Invoke-PiSsh "sudo install -o antifieldcloud -g antifieldcloud -m 0644 /tmp/antifieldcloud-pull.json /var/lib/antifieldcloud/backup-pull.json" | Out-Null
  Invoke-PiSsh "sudo rm -f /tmp/antifieldcloud-pull.json" | Out-Null

  try {
    Invoke-PiSsh "sudo rm -f '$archive'" | Out-Null
  } catch {
    Write-Log "警告：远端归档删除失败（下次备份会按保留策略清理）：$($_.Exception.Message)"
  }

  # 清理旧备份：daily 30 天、weekly 8 周。
  Get-ChildItem (Join-Path $destRoot "daily") -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Get-ChildItem (Join-Path $destRoot "weekly") -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-56) } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

  Write-Log "备份成功：$localPath"
}

for ($attempt = 1; $attempt -le 3; $attempt++) {
  try {
    Invoke-Pull
    exit 0
  } catch {
    Write-Log "第 $attempt 次尝试失败：$($_.Exception.Message)"
    if ($attempt -lt 3) { Start-Sleep -Seconds 60 }
  }
}
Write-Log "三次尝试均失败，请检查直连网线、Pi 状态或 D 盘空间"
exit 1

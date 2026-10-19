param(
  [string]$PiHost = "192.0.2.10",
  [string]$PiUser = "antifield",
  [string]$BackupRoot = (Join-Path $env:USERPROFILE "AntifieldCloudBackups"),
  [switch]$SkipSecrets
)

# 每日由 Windows 计划任务调用：两阶段备份协议。
# 1) 查询 Pi 上 pending 归档；没有 pending 才触发 --prepare 生成新归档；
# 2) 逐个下载到 .part → SHA-256 校验 → 原子改名 → 写 .sha256 旁文件 → --ack → 删除 Pi 归档；
# 3) 失败保留 pending（下一轮重试同一归档，不重复生成），最后写状态 JSON 供面板显示。
# 依赖：直连网线可达 $PiHost；SSH 公钥已配置；Pi 上已部署 antifieldcloud（迁移 2+）。
$ErrorActionPreference = "Stop"
$target = "$PiUser@$PiHost"
$base = Join-Path $env:LOCALAPPDATA "AntifieldCloud"
$destRoot = $BackupRoot
$logPath = Join-Path $base "backup.log"
$statusTmp = Join-Path $env:TEMP "antifieldcloud-pull.json"
New-Item -ItemType Directory -Force -Path $base, (Join-Path $destRoot "daily"), (Join-Path $destRoot "weekly"), (Join-Path $destRoot "secrets") | Out-Null

# 日志超过 1 MiB 轮转一次，避免长期运行无限增长。
if ((Test-Path $logPath) -and ((Get-Item $logPath).Length -gt 1MB)) {
  Move-Item -Force $logPath "$logPath.1"
}

function Write-Log {
  param([string]$Message)
  $line = "{0} {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -Path $logPath -Value $line -Encoding UTF8
  Write-Host $line
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

# 解析远端 CLI 的最后一行 JSON；输出中的 stderr 警告会被忽略。
function Invoke-RemoteJson {
  param([string]$Command, [int]$Attempts = 2)
  $output = Invoke-PiSsh $Command -Attempts $Attempts
  $jsonLines = @($output | ForEach-Object { [string]$_ } | Where-Object { $_ -match '^\s*\{' })
  if ($jsonLines.Count -eq 0) { throw "远端命令没有返回 JSON：$output" }
  return ($jsonLines[$jsonLines.Count - 1] | ConvertFrom-Json)
}

function ConvertTo-RemotePath {
  param([string]$Name)
  if ($Name -notmatch '^snapshot-[0-9TZ]+(-[0-9]+)?-(full|inc)\.tar\.gz$') { throw "归档名异常：$Name" }
  return "/var/lib/antifieldcloud/backups/$Name"
}

function Copy-FromPi {
  param([string]$Remote, [string]$Local, [int]$Attempts = 3)
  $part = "$Local.part"
  if (Test-Path $part) { Remove-Item -Force $part -ErrorAction SilentlyContinue }
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    & scp.exe -o BatchMode=yes -o ConnectTimeout=10 "$target`:$Remote" $part 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { return $part }
    if (Test-Path $part) { Remove-Item -Force $part -ErrorAction SilentlyContinue }
    if ($attempt -eq $Attempts) { throw "scp 失败（exit=$LASTEXITCODE）：$Remote" }
    Start-Sleep -Seconds 10
  }
}

function Write-ShaSidecar {
  param([string]$ArchivePath, [string]$Sha256)
  $sidecar = "$ArchivePath.sha256"
  $line = "{0}  {1}" -f $Sha256.ToLower(), (Split-Path -Leaf $ArchivePath)
  [System.IO.File]::WriteAllText($sidecar, $line + "`n", (New-Object System.Text.UTF8Encoding($false)))
}

function Get-LocalHash {
  param([string]$Path)
  return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLower()
}

function Copy-ToPi {
  param([string]$Local, [string]$Remote)
  & scp.exe -o BatchMode=yes -o ConnectTimeout=10 $Local "$target`:$Remote" 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "scp 上传失败（exit=$LASTEXITCODE）：$Local" }
}

function Update-PiStatus {
  param([long]$SizeBytes, [string]$ArchiveName, [string]$Mode, [int]$PendingRemaining)
  $status = @{
    lastPullAt       = (Get-Date).ToUniversalTime().ToString("o")
    sizeBytes       = $SizeBytes
    ok              = $true
    archiveName     = $ArchiveName
    mode            = $Mode
    pendingRemaining = $PendingRemaining
  } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($statusTmp, $status, (New-Object System.Text.UTF8Encoding($false)))
  Copy-ToPi $statusTmp "/tmp/antifieldcloud-pull.json"
  Invoke-PiSsh "sudo install -o antifieldcloud -g antifieldcloud -m 0644 /tmp/antifieldcloud-pull.json /var/lib/antifieldcloud/backup-pull.json" | Out-Null
  Invoke-PiSsh "sudo rm -f /tmp/antifieldcloud-pull.json" | Out-Null
}

# 拉取加密密钥备份（age）：best-effort，未配置 age/受信公钥时只记录警告。
function Invoke-SecretsPull {
  $script = "/opt/antifieldcloud/current/scripts/backup-secrets.sh"
  $exists = (Invoke-PiSsh "test -f '$script' && echo YES || echo NO") -join ""
  if ($exists -notmatch "YES") { Write-Log "跳过密钥备份：Pi 上未安装 backup-secrets.sh"; return }
  $meta = Invoke-RemoteJson "sudo bash '$script'"
  if (-not $meta.ok) {
    Write-Log "警告：密钥备份未生成（$($meta.error)）；不影响文件备份"
    return
  }
  $name = [string]$meta.archiveName
  if ($name -notmatch '^secrets-[0-9TZ-]+\.tar\.age$') { throw "密钥归档名异常：$name" }
  $remote = "/var/lib/antifieldcloud/backups/secrets/$name"
  $dateDir = Join-Path (Join-Path $destRoot "secrets") (Get-Date).ToString("yyyy-MM-dd")
  New-Item -ItemType Directory -Force -Path $dateDir | Out-Null
  $local = Join-Path $dateDir $name
  if (-not (Test-Path $local)) {
    $part = Copy-FromPi $remote $local
    if ((Get-LocalHash $part) -ne ([string]$meta.sha256).ToLower()) {
      Remove-Item -Force $part -ErrorAction SilentlyContinue
      throw "密钥归档 SHA-256 校验失败：$name"
    }
    Move-Item -Force $part $local
  }
  Write-ShaSidecar $local ([string]$meta.sha256)
  try {
    Invoke-PiSsh "sudo rm -f '$remote'" | Out-Null
  } catch {
    Write-Log "警告：远端密钥归档删除失败：$($_.Exception.Message)"
  }
  Write-Log "密钥备份已拉取：$local"
}

function Invoke-Pull {
  if (-not (Test-PiReachable)) { throw "Pi 直连不可达（$PiHost:22），请检查网线/地址" }

  $cli = "sudo -u antifieldcloud -H /usr/local/bin/node /opt/antifieldcloud/current/scripts/backup.mjs"
  $pending = Invoke-RemoteJson "$cli --pending"
  if (-not $pending.ok) { throw "查询 pending 失败：$($pending.error)" }

  $archives = @()
  if ([int]$pending.count -eq 0) {
    $fullArg = if ($pending.recommendedMode -eq "full") { "--full" } else { "" }
    Write-Log "准备新归档（mode=$(if ($fullArg) { 'full' } else { 'inc' })）"
    $prepared = Invoke-RemoteJson "$cli --prepare $fullArg"
    if (-not $prepared.ok) { throw "生成归档失败：$($prepared.error)" }
    $archives = @([pscustomobject]@{
      name = [string]$prepared.archiveName; mode = [string]$prepared.mode
      sha256 = [string]$prepared.sha256; sizeBytes = [long]$prepared.sizeBytes
    })
  } else {
    Write-Log "发现 $($pending.count) 个 pending 归档，继续拉取"
    $archives = @($pending.pending)
  }

  $totalBytes = [long]0
  $lastName = ""
  $lastMode = "inc"
  foreach ($archive in $archives) {
    $name = [string]$archive.name
    $mode = [string]$archive.mode
    $sha = ([string]$archive.sha256).ToLower()
    $size = [long]$archive.sizeBytes
    if ($name -eq "" -or $sha -notmatch '^[0-9a-f]{64}$') { throw "pending 归档字段异常：$name" }
    $remote = ConvertTo-RemotePath $name
    if ($archive.exists -eq $false) { throw "pending 归档文件不存在（需人工检查）：$name" }

    $folder = if ($mode -eq "full") { "weekly" } else { "daily" }
    $dateDir = Join-Path (Join-Path $destRoot $folder) (Get-Date).ToString("yyyy-MM-dd")
    New-Item -ItemType Directory -Force -Path $dateDir | Out-Null
    $localPath = Join-Path $dateDir $name

    if (Test-Path $localPath) {
      # 上一轮已下载但 ack 未成功：校验后直接补 ack，不重新下载。
      if ((Get-LocalHash $localPath) -ne $sha) {
        Write-Log "本地归档哈希不符，重新下载：$name"
        Remove-Item -Force $localPath -ErrorAction SilentlyContinue
      }
    }
    if (-not (Test-Path $localPath)) {
      Write-Log "下载 $name（$size bytes）"
      $part = Copy-FromPi $remote $localPath
      if ((Get-LocalHash $part) -ne $sha) {
        Remove-Item -Force $part -ErrorAction SilentlyContinue
        throw "SHA-256 校验失败：$name（远端记录 $sha）"
      }
      Move-Item -Force $part $localPath
    }
    Write-ShaSidecar $localPath $sha

    $ack = Invoke-RemoteJson "$cli --ack '$name' --sha256 '$sha'"
    if (-not $ack.ok) { throw "ack 失败：$($ack.error)" }
    try {
      Invoke-PiSsh "sudo rm -f '$remote'" | Out-Null
    } catch {
      Write-Log "警告：远端归档删除失败（下次 ack 会按保留策略清理）：$($_.Exception.Message)"
    }
    $totalBytes += $size
    $lastName = $name
    $lastMode = $mode
    Write-Log "备份已确认：$localPath"
  }
  try {
    $after = Invoke-RemoteJson "$cli --pending"
    Update-PiStatus -SizeBytes $totalBytes -ArchiveName $lastName -Mode $lastMode -PendingRemaining ([int]$after.count)
  } catch {
    Write-Log "警告：状态 JSON 写入失败（不影响备份）：$($_.Exception.Message)"
  }



  # 清理旧备份：daily 30 天、weekly 8 周、secrets 90 天。
  Get-ChildItem (Join-Path $destRoot "daily") -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Get-ChildItem (Join-Path $destRoot "weekly") -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-56) } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Get-ChildItem (Join-Path $destRoot "secrets") -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-90) } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

  Write-Log "备份成功：$totalBytes bytes"
  if (-not $SkipSecrets) {
    try { Invoke-SecretsPull } catch { Write-Log "警告：密钥备份拉取失败（不影响文件备份）：$($_.Exception.Message)" }
  }
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
Write-Log "三次尝试均失败，请检查直连网线、Pi 状态、备份空间或 pending 归档"
exit 1
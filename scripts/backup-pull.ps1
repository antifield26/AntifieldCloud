param(
  [string]$PiHost = "192.0.2.10",
  [string]$PiUser = "antifield",
  [string]$BackupRoot = (Join-Path $env:USERPROFILE "AntifieldCloudBackups"),
  [switch]$SkipSecrets,
  [int]$CommandTimeoutSec = 60,
  [int]$PrepareTimeoutSec = 3600,
  [int]$SecretsTimeoutSec = 300
)

# 每日由 Windows 计划任务调用：两阶段备份协议 + 密钥包。
# 1) 查询 Pi 上 pending 归档；没有 pending 才触发 --prepare 生成新归档；
# 2) 逐个下载到 .part → SHA-256 校验 → 原子改名 → 写 .sha256 旁文件 → --ack → 删除 Pi 归档/旁文件；
# 3) 密钥包独立步骤，成功/失败都写入状态 JSON（secretsOk/secretsLastError/lastSecretsAt），失败可见；
# 4) 失败保留 pending（下一轮重试同一归档，不重复生成）。
# 所有 SSH/SCP 命令都有硬超时（Start-Job + Wait-Job，超时 kill），不会无限挂起。
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

# 密钥包步骤状态：attempted/ok/lastError/lastSuccessAt/archiveName。
$script:secretsState = @{
  attempted     = $false
  ok            = $null
  lastError     = $null
  lastSuccessAt = $null
  archiveName   = $null
}
$script:lastArchiveName = ""
$script:lastArchiveMode = ""
$script:lastArchiveBytes = [long]0

function Write-Log {
  param([string]$Message)
  $line = "{0} {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -Path $logPath -Value $line -Encoding UTF8
  Write-Host $line
}

# 在独立 runspace 中执行命令；超时则 Stop-Job 并抛错，保证不会无限等待。
function Invoke-WithTimeout {
  param(
    [scriptblock]$ScriptBlock,
    [object[]]$ArgumentList,
    [int]$TimeoutSeconds,
    [string]$Label
  )
  $job = Start-Job -ScriptBlock $ScriptBlock -ArgumentList $ArgumentList
  try {
    $finished = Wait-Job -Job $job -Timeout $TimeoutSeconds
    if (-not $finished) {
      Stop-Job -Job $job -ErrorAction SilentlyContinue
      throw "命令超时（${TimeoutSeconds}s）：$Label"
    }
    if ($job.State -ne "Completed") {
      throw "命令执行失败（$($job.State)）：$Label"
    }
    $results = @(Receive-Job -Job $job -ErrorAction SilentlyContinue)
    $result = $results | Where-Object { $_ -is [pscustomobject] } | Select-Object -Last 1
    if (-not $result) { throw "命令没有返回结果：$Label" }
    return $result
  } finally {
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-NativeWithTimeout {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [int]$TimeoutSeconds,
    [string]$Label
  )
  $block = {
    param($exe, $arguments, $commandLabel)
    $output = & $exe @arguments 2>&1
    $exitCode = $LASTEXITCODE
    [pscustomobject]@{
      Label    = $commandLabel
      ExitCode = $exitCode
      Output   = (($output | ForEach-Object { [string]$_ }) -join "`n")
    }
  }
  return Invoke-WithTimeout -ScriptBlock $block -ArgumentList @($FilePath, $Arguments, $Label) -TimeoutSeconds $TimeoutSeconds -Label $Label
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
  param([string]$Command, [int]$Attempts = 2, [int]$TimeoutSeconds = $CommandTimeoutSec)
  $arguments = @(
    "-n",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2",
    $target,
    $Command
  )
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    $result = Invoke-NativeWithTimeout -FilePath "ssh.exe" -Arguments $arguments -TimeoutSeconds $TimeoutSeconds -Label "ssh: $Command"
    if ($result.ExitCode -eq 0) { return $result.Output }
    if ($attempt -eq $Attempts) {
      throw "ssh 失败（exit=$($result.ExitCode)）：$($result.Output)"
    }
    Start-Sleep -Seconds 10
  }
}

# 解析远端 CLI 的最后一行 JSON；stderr/提示行会被忽略。
function Invoke-RemoteJson {
  param([string]$Command, [int]$Attempts = 2, [int]$TimeoutSeconds = $CommandTimeoutSec)
  $output = Invoke-PiSsh $Command -Attempts $Attempts -TimeoutSeconds $TimeoutSeconds
  $jsonLines = @(($output -split "`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\{' })
  if ($jsonLines.Count -eq 0) { throw "远端命令没有返回 JSON：$output" }
  return ($jsonLines[$jsonLines.Count - 1] | ConvertFrom-Json)
}

function ConvertTo-RemoteArchivePath {
  param([string]$Name)
  if ($Name -notmatch '^snapshot-[0-9TZ]+(-[0-9]+)?-(full|inc)\.tar\.gz$') { throw "归档名异常：$Name" }
  return "/var/lib/antifieldcloud/backups/$Name"
}

function Get-DownloadTimeout {
  param([long]$SizeBytes)
  $sizeMB = [Math]::Max(1, [Math]::Ceiling($SizeBytes / [double]1MB))
  return [int][Math]::Min(7200, [Math]::Max(180, $sizeMB * 30))
}

function Copy-FromPi {
  param([string]$Remote, [string]$Local, [long]$SizeBytes = 0)
  $part = "$Local.part"
  if (Test-Path $part) { Remove-Item -Force $part -ErrorAction SilentlyContinue }
  $timeout = Get-DownloadTimeout $SizeBytes
  $arguments = @(
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2",
    "$target`:$Remote",
    $part
  )
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      $result = Invoke-NativeWithTimeout -FilePath "scp.exe" -Arguments $arguments -TimeoutSeconds $timeout -Label "scp: $Remote"
    } catch {
      if (Test-Path $part) { Remove-Item -Force $part -ErrorAction SilentlyContinue }
      throw
    }
    if ($result.ExitCode -eq 0) { return $part }
    if (Test-Path $part) { Remove-Item -Force $part -ErrorAction SilentlyContinue }
    if ($attempt -eq 3) { throw "scp 失败（exit=$($result.ExitCode)）：$Remote" }
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
  param([string]$Local, [string]$Remote, [int]$TimeoutSeconds = $CommandTimeoutSec)
  $arguments = @(
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    $Local,
    "$target`:$Remote"
  )
  $result = Invoke-NativeWithTimeout -FilePath "scp.exe" -Arguments $arguments -TimeoutSeconds $TimeoutSeconds -Label "scp upload: $Remote"
  if ($result.ExitCode -ne 0) { throw "scp 上传失败（exit=$($result.ExitCode)）：$Local" }
}

# 写状态 JSON：ok 仅在文件归档成功且密钥包明确成功/跳过时为 true；secrets 失败时 ok=false 且带错误字段。
function Write-PiStatus {
  param([int]$PendingRemaining)
  $secretsFailed = ($script:secretsState.attempted -and ($script:secretsState.ok -eq $false))
  $status = @{
    lastPullAt          = (Get-Date).ToUniversalTime().ToString("o")
    sizeBytes           = [long]$script:lastArchiveBytes
    ok                  = (-not $secretsFailed)
    archiveName         = $script:lastArchiveName
    mode                = $script:lastArchiveMode
    pendingRemaining    = $PendingRemaining
    secretsAttempted    = [bool]$script:secretsState.attempted
    secretsOk           = $script:secretsState.ok
    secretsLastError    = $script:secretsState.lastError
    lastSecretsAt       = $script:secretsState.lastSuccessAt
    secretsArchiveName  = $script:secretsState.archiveName
  } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($statusTmp, $status, (New-Object System.Text.UTF8Encoding($false)))
  Copy-ToPi $statusTmp "/tmp/antifieldcloud-pull.json"
  Invoke-PiSsh "sudo install -o antifieldcloud -g antifieldcloud -m 0644 /tmp/antifieldcloud-pull.json /var/lib/antifieldcloud/backup-pull.json" | Out-Null
  Invoke-PiSsh "sudo rm -f /tmp/antifieldcloud-pull.json" | Out-Null
}

# 远端 secrets 目录清理：删除已拉到本地的旧 .age 及其 .sha256，以及无 .age 对应的 .sha256 孤儿。
function Clear-RemoteSecretOrphans {
  param([string]$KeepName)
  $listingText = Invoke-PiSsh "sudo ls -1 /var/lib/antifieldcloud/backups/secrets 2>/dev/null || true"
  $names = @(($listingText -split "`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })
  if ($names.Count -eq 0) { return }
  $remotePaths = @()
  foreach ($name in $names) {
    if ($name -notmatch '^secrets-[0-9TZ-]+\.tar\.age(\.sha256)?$') { continue }
    if ($name -eq $KeepName) { continue }
    if ($name -like "*.sha256") {
      $baseName = $name.Substring(0, $name.Length - 7)
      if ($names -notcontains $baseName) { $remotePaths += "/var/lib/antifieldcloud/backups/secrets/$name" }
      continue
    }
    $localMatches = @(Get-ChildItem -Path (Join-Path $destRoot "secrets") -Recurse -Filter $name -File -ErrorAction SilentlyContinue)
    if ($localMatches.Count -gt 0) {
      $remotePaths += "/var/lib/antifieldcloud/backups/secrets/$name"
      if ($names -contains "$name.sha256") { $remotePaths += "/var/lib/antifieldcloud/backups/secrets/$name.sha256" }
    }
  }
  if ($remotePaths.Count -eq 0) { return }
  $quoted = ($remotePaths | ForEach-Object { "'$_'" }) -join " "
  Invoke-PiSsh "sudo rm -f $quoted" | Out-Null
}

# 密钥包拉取：独立 try/状态，失败只记录并在状态 JSON 中可见，不影响文件归档已成功的事实。
function Invoke-SecretsPull {
  $script:secretsState.attempted = $true
  $script:secretsState.ok = $null
  $script:secretsState.lastError = $null
  $scriptPath = "/opt/antifieldcloud/current/scripts/backup-secrets.sh"
  try {
    $exists = (Invoke-PiSsh "test -f '$scriptPath' && echo YES || echo NO" -TimeoutSeconds 30) -join ""
    if ($exists -notmatch "YES") {
      $script:secretsState.attempted = $false
      $script:secretsState.lastError = "Pi 上未安装 backup-secrets.sh"
      Write-Log "跳过密钥备份：$($script:secretsState.lastError)"
      return
    }
    $meta = Invoke-RemoteJson "sudo /usr/bin/timeout -k 10 240 bash '$scriptPath'" -TimeoutSeconds $SecretsTimeoutSec
    if (-not $meta.ok) { throw "密钥备份失败：$($meta.error)" }
    $name = [string]$meta.archiveName
    if ($name -notmatch '^secrets-[0-9TZ-]+\.tar\.age$') { throw "密钥归档名异常：$name" }
    $sha = ([string]$meta.sha256).ToLower()
    if ($sha -notmatch '^[0-9a-f]{64}$') { throw "密钥归档 SHA 异常：$name" }
    $size = [long]$meta.sizeBytes
    $remote = "/var/lib/antifieldcloud/backups/secrets/$name"
    $dateDir = Join-Path (Join-Path $destRoot "secrets") (Get-Date).ToString("yyyy-MM-dd")
    New-Item -ItemType Directory -Force -Path $dateDir | Out-Null
    $local = Join-Path $dateDir $name
    if ((Test-Path $local) -and ((Get-LocalHash $local) -eq $sha)) {
      Write-Log "密钥归档已存在：$local"
    } else {
      if (Test-Path $local) { Remove-Item -Force $local -ErrorAction SilentlyContinue }
      $part = Copy-FromPi $remote $local $size
      $actual = Get-LocalHash $part
      if ($actual -ne $sha) {
        Remove-Item -Force $part -ErrorAction SilentlyContinue
        throw "密钥归档 SHA-256 校验失败：$name（本地 $actual / 期望 $sha）"
      }
      Move-Item -Force $part $local
    }
    Write-ShaSidecar $local $sha
    Invoke-PiSsh "sudo rm -f '$remote' '$remote.sha256'" | Out-Null
    try { Clear-RemoteSecretOrphans -KeepName $name } catch { Write-Log "警告：远端密钥孤儿清理失败：$($_.Exception.Message)" }
    $script:secretsState.ok = $true
    $script:secretsState.lastSuccessAt = (Get-Date).ToUniversalTime().ToString("o")
    $script:secretsState.archiveName = $name
    Write-Log "密钥备份已拉取：$local"
  } catch {
    $script:secretsState.ok = $false
    $script:secretsState.lastError = $_.Exception.Message
    Write-Log "警告：密钥备份失败（已写入状态 JSON）：$($_.Exception.Message)"
  }
}

function Invoke-Pull {
  if (-not (Test-PiReachable)) { throw "Pi 直连不可达（$PiHost:22），请检查网线/地址" }

  $script:secretsState = @{ attempted = $false; ok = $null; lastError = $null; lastSuccessAt = $null; archiveName = $null }
  $script:lastArchiveName = ""
  $script:lastArchiveMode = ""
  $script:lastArchiveBytes = [long]0

  $cli = "sudo -u antifieldcloud -H /usr/local/bin/node /opt/antifieldcloud/current/scripts/backup.mjs"
  $pending = Invoke-RemoteJson "$cli --pending --no-warnings"
  if (-not $pending.ok) { throw "查询 pending 失败：$($pending.error)" }
  if ($pending.warnings) {
    foreach ($warning in @($pending.warnings)) { Write-Log "远端提示：$warning" }
  }

  $archives = @()
  if ([int]$pending.count -eq 0) {
    $fullArg = if ($pending.recommendedMode -eq "full") { "--full" } else { "" }
    Write-Log "准备新归档（mode=$(if ($fullArg) { 'full' } else { 'inc' })）"
    $prepared = Invoke-RemoteJson "timeout -k 30 3300 $cli --prepare $fullArg" -Attempts 1 -TimeoutSeconds $PrepareTimeoutSec
    if (-not $prepared.ok) { throw "生成归档失败：$($prepared.error)" }
    if ($prepared.warnings) {
      foreach ($warning in @($prepared.warnings)) { Write-Log "远端提示：$warning" }
    }
    $archives = @([pscustomobject]@{
      name = [string]$prepared.archiveName; mode = [string]$prepared.mode
      sha256 = [string]$prepared.sha256; sizeBytes = [long]$prepared.sizeBytes
    })
  } else {
    Write-Log "发现 $($pending.count) 个 pending 归档，继续拉取"
    $archives = @($pending.pending)
  }

  foreach ($archive in $archives) {
    $name = [string]$archive.name
    $mode = [string]$archive.mode
    $sha = ([string]$archive.sha256).ToLower()
    $size = [long]$archive.sizeBytes
    if ($name -eq "" -or $sha -notmatch '^[0-9a-f]{64}$') { throw "pending 归档字段异常：$name" }
    $remote = ConvertTo-RemoteArchivePath $name
    if ($archive.exists -eq $false) { throw "pending 归档文件不存在（需人工检查）：$name" }

    $folder = if ($mode -eq "full") { "weekly" } else { "daily" }
    $dateDir = Join-Path (Join-Path $destRoot $folder) (Get-Date).ToString("yyyy-MM-dd")
    New-Item -ItemType Directory -Force -Path $dateDir | Out-Null
    $localPath = Join-Path $dateDir $name

    if (Test-Path $localPath) {
      if ((Get-LocalHash $localPath) -ne $sha) {
        Write-Log "本地归档哈希不符，重新下载：$name"
        Remove-Item -Force $localPath -ErrorAction SilentlyContinue
      }
    }
    if (-not (Test-Path $localPath)) {
      Write-Log "下载 $name（$size bytes）"
      $part = Copy-FromPi $remote $localPath $size
      if ((Get-LocalHash $part) -ne $sha) {
        Remove-Item -Force $part -ErrorAction SilentlyContinue
        throw "SHA-256 校验失败：$name（远端记录 $sha）"
      }
      Move-Item -Force $part $localPath
    }
    Write-ShaSidecar $localPath $sha

    $ack = Invoke-RemoteJson "timeout -k 10 900 $cli --ack '$name' --sha256 '$sha'" -TimeoutSeconds (Get-DownloadTimeout $size)
    if (-not $ack.ok) { throw "ack 失败：$($ack.error)" }
    try {
      Invoke-PiSsh "sudo rm -f '$remote' '$remote.sha256'" | Out-Null
    } catch {
      Write-Log "警告：远端归档删除失败（下次 ack 会按保留策略清理）：$($_.Exception.Message)"
    }
    $script:lastArchiveBytes += $size
    $script:lastArchiveName = $name
    $script:lastArchiveMode = $mode
    Write-Log "备份已确认：$localPath"
  }

  if (-not $SkipSecrets) { Invoke-SecretsPull }

  try {
    $after = Invoke-RemoteJson "$cli --pending --no-warnings"
    Write-PiStatus -PendingRemaining ([int]$after.count)
  } catch {
    throw "状态 JSON 写入失败：$($_.Exception.Message)"
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

  if ($script:secretsState.attempted -and ($script:secretsState.ok -eq $false)) {
    Write-Log "文件归档成功，但密钥备份失败（状态 ok=false）：$($script:secretsState.lastError)"
  } else {
    Write-Log "备份成功：$($script:lastArchiveBytes) bytes（secrets=$(if ($script:secretsState.ok -eq $true) { 'ok' } else { 'skipped' })）"
  }
}

for ($attempt = 1; $attempt -le 3; $attempt++) {
  try {
    Invoke-Pull
    if ($script:secretsState.attempted -and ($script:secretsState.ok -eq $false)) {
      # 文件归档已成功且幂等；密钥失败单独以退出码 1 暴露，不在同一窗口重复生成新归档。
      exit 1
    }
    exit 0
  } catch {
    Write-Log "第 $attempt 次尝试失败：$($_.Exception.Message)"
    if ($attempt -lt 3) { Start-Sleep -Seconds 60 }
  }
}
Write-Log "三次尝试均失败，请检查直连网线、Pi 状态、备份空间或 pending 归档"
exit 1
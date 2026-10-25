param(
  [string]$PiHost = "192.0.2.10",
  [string]$PiUser = "antifield",
  [string]$BackupRoot = (Join-Path $env:USERPROFILE "AntifieldCloudBackups"),
  [int]$Keep = 4,
  [int]$CommandTimeoutSec = 60,
  [string]$RemoteBackupDir = "/var/lib/antifieldcloud/world-backups",
  [string]$RemoteStatusPath = "/var/lib/antifieldcloud/world-pull-status.json",
  [switch]$NoStatusWrite
)

# 世界备份拉取（Windows 周度任务）：两阶段确认协议的世界版本。
# 1) 查询 Pi 的 world-backups 列表与 world-backup-status.json；
# 2) 逐个 scp 到本地 .part → 本地 SHA-256 与远端 .sha256 旁文件比对 → 原子改名 + 本地 .sha256；
# 3) 只有本地校验成功后才删除远端归档/旁文件（ack）；失败保留远端、不 ack、退出码 1；
# 4) 本地保留最新 Keep 份（只删 world-<UTC>.tar.gz 匹配名）；
# 5) 写远端 /var/lib/antifieldcloud/world-pull-status.json（ASCII 字段，sudo install 0644）。
# 所有 ssh/scp 都有硬超时，超时通过 taskkill /T /F 杀进程树，不会无限挂起。
# 依赖：直连网线可达 $PiHost；SSH 公钥已配置；Pi 上已安装 antifieldcloud-world.timer 并至少生成过一份归档。
$ErrorActionPreference = "Stop"
# OP-06：远端为 UTF-8；PS 5.1 默认按 GBK 解码 ssh 输出会让中文 JSON 解析失败，这里显式统一编码。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$target = "$PiUser@$PiHost"
$base = Join-Path $env:LOCALAPPDATA "AntifieldCloud"
$logPath = Join-Path $base "world-pull.log"
$worldRoot = Join-Path $BackupRoot "world"
$backupStatusPath = "/var/lib/antifieldcloud/world-backup-status.json"
$statusTmp = Join-Path $env:TEMP ("antifieldcloud-world-pull-" + [guid]::NewGuid().ToString("N") + ".json")

New-Item -ItemType Directory -Force -Path $base, $worldRoot | Out-Null

if ($Keep -lt 1) { throw "Keep 必须 ≥ 1（实际：$Keep）" }
if ($RemoteBackupDir -notmatch '^/[A-Za-z0-9/._-]+$' -or $RemoteBackupDir -match '\.\.') {
  throw "RemoteBackupDir 非法：$RemoteBackupDir"
}
if ($RemoteStatusPath -notmatch '^/[A-Za-z0-9/._-]+$' -or $RemoteStatusPath -match '\.\.') {
  throw "RemoteStatusPath 非法：$RemoteStatusPath"
}

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

# 状态 JSON 只写 ASCII：非 ASCII 字符替换为 ?，避免 PS 5.1 解码差异导致面板/告警解析失败。
function ConvertTo-AsciiText {
  param([string]$Text)
  if ($null -eq $Text) { return $null }
  $builder = New-Object System.Text.StringBuilder
  foreach ($char in $Text.ToCharArray()) {
    $code = [int]$char
    if ($code -ge 32 -and $code -lt 127) { [void]$builder.Append($char) } else { [void]$builder.Append('?') }
  }
  return $builder.ToString()
}

# 带错误码的异常：状态 JSON 只记录 code + 英文/ASCII message。
function New-PullException {
  param([string]$Code, [string]$Message)
  $exception = New-Object System.Exception($Message)
  $exception.Data["code"] = $Code
  return $exception
}

function Throw-PullError {
  param([string]$Code, [string]$Message)
  throw (New-PullException -Code $Code -Message $Message)
}

# 把参数数组拼成 Windows 命令行字符串，含空格的参数加双引号（PS 5.1 的 Start-Process 只接受字符串）。
function ConvertTo-ArgumentString {
  param([string[]]$Arguments)
  $quoted = foreach ($argument in $Arguments) {
    if ($argument -match '[\s"]') { '"' + ($argument -replace '"', '\"') + '"' } else { $argument }
  }
  return ($quoted -join " ")
}

# 执行本地进程并硬超时：超时用 taskkill /T /F 杀整棵进程树（OP-18），失败保留原始异常。
function Invoke-NativeWithTimeout {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [int]$TimeoutSeconds,
    [string]$Label
  )
  $stdoutPath = [System.IO.Path]::GetTempFileName()
  $stderrPath = [System.IO.Path]::GetTempFileName()
  $commandLine = ConvertTo-ArgumentString -Arguments $Arguments
  $process = $null
  try {
    $process = Start-Process -FilePath $FilePath -ArgumentList $commandLine -PassThru -NoNewWindow `
      -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    # PS 5.1：Start-Process -PassThru 必须缓存 Handle 后 WaitForExit，ExitCode 才有值。
    $null = $process.Handle
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      try {
        & taskkill.exe /T /F /PID $process.Id 2>&1 | Out-Null
      } catch {
        try { $process.Kill() } catch { }
      }
      Throw-PullError -Code "command_timeout" -Message ("命令超时（${TimeoutSeconds}s，已杀进程树）：$Label")
    }
    $stdoutRaw = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw -Encoding UTF8 -ErrorAction SilentlyContinue } else { $null }
    $stderrRaw = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw -Encoding UTF8 -ErrorAction SilentlyContinue } else { $null }
    # Get-Content -Raw 对空文件返回 AutomationNull，[string] 转换后仍不是普通空串，需显式归一化。
    $stdoutText = if ($null -eq $stdoutRaw) { "" } else { [string]$stdoutRaw }
    $stderrText = if ($null -eq $stderrRaw) { "" } else { [string]$stderrRaw }
    $exitCode = if ($null -eq $process.ExitCode) { -1 } else { [int]$process.ExitCode }
    return [pscustomobject]@{
      Label    = $Label
      ExitCode = $exitCode
      StdOut   = $stdoutText.Trim()
      StdErr   = $stderrText.Trim()
      Output   = ((@($stdoutText, $stderrText) -join "`n").Trim())
    }
  } catch {
    # 保留原始异常（超时/启动失败），只清理临时文件。
    throw
  } finally {
    Remove-Item -Force $stdoutPath, $stderrPath -ErrorAction SilentlyContinue
  }
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
  param([string]$Command, [int]$Attempts = 3, [int]$TimeoutSeconds = $CommandTimeoutSec)
  $arguments = @(
    "-n",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2",
    $target,
    $Command
  )
  $lastResult = $null
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    $result = Invoke-NativeWithTimeout -FilePath "ssh.exe" -Arguments $arguments -TimeoutSeconds $TimeoutSeconds -Label "ssh: $Command"
    if ($result.ExitCode -eq 0) { return $result.Output }
    $lastResult = $result
    if ($attempt -lt $Attempts) { Start-Sleep -Seconds 5 }
  }
  throw (New-PullException -Code "ssh_failed" -Message ("ssh 失败（exit=$($lastResult.ExitCode)）：$($lastResult.Output)"))
}

# 解析远端 CLI/状态 JSON：忽略日志与提示行，只取最后一条 { ... }；解析失败返回 $null。
function ConvertFrom-RemoteJsonText {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
  $lines = @($Text -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\{.*\}$' })
  if ($lines.Count -eq 0) { return $null }
  try {
    return ($lines[$lines.Count - 1] | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

function Write-ShaSidecar {
  param([string]$ArchivePath, [string]$Sha256)
  $sidecar = "$ArchivePath.sha256"
  $line = "{0}  {1}" -f $Sha256.ToLower(), (Split-Path -Leaf $ArchivePath)
  Write-Utf8NoBom -Path $sidecar -Content ($line + "`n")
}

function Get-LocalHash {
  param([string]$Path)
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLower()
}

# 远端归档名白名单：只接受本脚本自己备份产生的 world-<UTC>.tar.gz。
function Assert-ArchiveName {
  param([string]$Name)
  if ($Name -notmatch '^world-\d{8}T\d{6}Z\.tar\.gz$') {
    Throw-PullError -Code "invalid_archive_name" -Message "远端归档名异常：$Name"
  }
}

function Get-RemoteSnapshot {
  # 一次 ssh 同时取目录是否存在、归档列表与备份状态；避免多次往返放大直连丢包概率。
  $command = "if [ -d '$RemoteBackupDir' ]; then echo DIR_OK; ls -1 '$RemoteBackupDir' 2>/dev/null; else echo DIR_MISSING; fi; echo '---STATUS---'; cat '$backupStatusPath' 2>/dev/null || echo STATUS_MISSING"
  $output = Invoke-PiSsh -Command $command
  $lines = @(($output -split "`r?`n") | ForEach-Object { $_.Trim() })
  $dirOk = $false
  $names = New-Object System.Collections.Generic.List[string]
  $statusLines = New-Object System.Collections.Generic.List[string]
  $inStatus = $false
  foreach ($line in $lines) {
    if ($line -eq "DIR_OK") { $dirOk = $true; continue }
    if ($line -eq "DIR_MISSING") { $dirOk = $false; continue }
    if ($line -eq "---STATUS---") { $inStatus = $true; continue }
    if ($line -eq "") { continue }
    if ($inStatus) { $statusLines.Add($line) } else { $names.Add($line) }
  }
  if (-not $dirOk) {
    Throw-PullError -Code "remote_dir_missing" -Message "远端世界备份目录不存在：${PiHost}:$RemoteBackupDir（先安装 antifieldcloud-world.timer 并跑一次）"
  }
  $archives = @($names | Where-Object { $_ -match '^world-\d{8}T\d{6}Z\.tar\.gz$' } | Sort-Object)
  $status = ConvertFrom-RemoteJsonText -Text ($statusLines -join "`n")
  return [pscustomobject]@{
    Archives = $archives
    Status   = $status
  }
}

function Get-RemoteArchiveSha {
  param([string]$Name)
  Assert-ArchiveName -Name $Name
  # 世界备份先 rename 归档再写 sidecar：若拉取与备份刚好重叠，sidecar 可能晚几秒出现。
  # 这里做 3 次短重试，避免整个周度拉取因竞态失败（OPS-12）。
  $sidecarText = ""
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $sidecarText = (Invoke-PiSsh -Command "cat '$RemoteBackupDir/$Name.sha256' 2>/dev/null || echo SIDECAR_MISSING").Trim()
    if ($sidecarText -ne "SIDECAR_MISSING" -and $sidecarText -ne "") { break }
    if ($attempt -lt 3) {
      Write-Log "等待远端 .sha256 旁文件（可能世界备份仍在写，第 $attempt 次重试）：$Name"
      Start-Sleep -Seconds (5 * $attempt)
    }
  }
  if ($sidecarText -eq "SIDECAR_MISSING" -or $sidecarText -eq "") {
    Throw-PullError -Code "sidecar_missing" -Message "远端缺少 .sha256 旁文件（已重试 3 次，可能备份仍在进行）：$Name"
  }
  $match = [regex]::Match($sidecarText, '(?im)^([0-9a-f]{64})\s+')
  if (-not $match.Success) {
    Throw-PullError -Code "sidecar_invalid" -Message "远端 .sha256 旁文件格式异常：$Name"
  }
  return $match.Groups[1].Value.ToLower()
}

function Get-RemoteFileSize {
  param([string]$Path)
  $text = (Invoke-PiSsh -Command "stat -c %s '$Path' 2>/dev/null || echo SIZE_UNKNOWN").Trim()
  $size = [long]0
  if (-not [long]::TryParse($text, [ref]$size) -or $size -le 0) {
    Throw-PullError -Code "remote_stat_failed" -Message "无法读取远端文件大小：$Path"
  }
  return $size
}

function Get-DownloadTimeoutSeconds {
  param([long]$SizeBytes)
  $sizeMB = [Math]::Max(1, [Math]::Ceiling($SizeBytes / [double]1MB))
  # 世界归档约 3 GiB；按 30s/MiB 估计并夹在 300s..7200s。
  return [int][Math]::Min(7200, [Math]::Max(300, $sizeMB * 30))
}

function Copy-FromPi {
  param([string]$Remote, [string]$Local, [long]$SizeBytes)
  $part = "$Local.part"
  if (Test-Path -LiteralPath $part) { Remove-Item -Force -LiteralPath $part -ErrorAction SilentlyContinue }
  $timeout = Get-DownloadTimeoutSeconds -SizeBytes $SizeBytes
  $arguments = @(
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2",
    "${target}:$Remote",
    $part
  )
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      $result = Invoke-NativeWithTimeout -FilePath "scp.exe" -Arguments $arguments -TimeoutSeconds $timeout -Label "scp: $Remote"
    } catch {
      # 保留原始异常；清理 .part 失败时只记录警告，不覆盖原始错误。
      $original = $_
      if (Test-Path -LiteralPath $part) {
        try { Remove-Item -Force -LiteralPath $part -ErrorAction Stop } catch { Write-Log "警告：删除半成品失败（$part）：$($_.Exception.Message)" }
      }
      throw $original
    }
    if ($result.ExitCode -eq 0) { return $part }
    if (Test-Path -LiteralPath $part) { Remove-Item -Force -LiteralPath $part -ErrorAction SilentlyContinue }
    if ($attempt -eq 3) {
      Throw-PullError -Code "scp_failed" -Message "scp 失败（exit=$($result.ExitCode)）：$Remote"
    }
    Start-Sleep -Seconds 10
  }
}

function Invoke-Ack {
  param([string]$Name)
  Assert-ArchiveName -Name $Name
  $archive = "$RemoteBackupDir/$Name"
  $sidecar = "$archive.sha256"
  # 只有本地 SHA-256 校验并原子改名成功后才删除远端归档（两阶段 ack）。
  Invoke-PiSsh -Command "sudo rm -f -- '$archive' '$sidecar'" | Out-Null
}

function Invoke-PullArchive {
  param([string]$Name)
  Assert-ArchiveName -Name $Name
  $expectedSha = Get-RemoteArchiveSha -Name $Name
  $remotePath = "$RemoteBackupDir/$Name"
  $localPath = Join-Path $worldRoot $Name
  if ((Test-Path -LiteralPath $localPath) -and ((Get-LocalHash -Path $localPath) -eq $expectedSha)) {
    Write-Log "本地已存在且 SHA-256 一致，直接 ack：$Name"
    Write-ShaSidecar -ArchivePath $localPath -Sha256 $expectedSha
    Invoke-Ack -Name $Name
    return [pscustomobject]@{ Name = $Name; Sha256 = $expectedSha; SizeBytes = (Get-Item -LiteralPath $localPath).Length; Skipped = $true }
  }
  if (Test-Path -LiteralPath $localPath) {
    Write-Log "本地同名归档 SHA-256 不一致，重新下载：$Name"
    Remove-Item -Force -LiteralPath $localPath -ErrorAction SilentlyContinue
    Remove-Item -Force -LiteralPath "$localPath.sha256" -ErrorAction SilentlyContinue
  }
  $sizeBytes = Get-RemoteFileSize -Path $remotePath
  Write-Log "下载 $Name（$sizeBytes bytes，超时 $((Get-DownloadTimeoutSeconds -SizeBytes $sizeBytes))s）"
  $part = Copy-FromPi -Remote $remotePath -Local $localPath -SizeBytes $sizeBytes
  $actualSha = Get-LocalHash -Path $part
  if ($actualSha -ne $expectedSha) {
    try { Remove-Item -Force -LiteralPath $part -ErrorAction Stop } catch { Write-Log "警告：删除校验失败的半成品失败（$part）：$($_.Exception.Message)" }
    Throw-PullError -Code "sha256_mismatch" -Message ("SHA-256 校验失败：$Name（本地 $actualSha / 期望 $expectedSha）")
  }
  Move-Item -Force -LiteralPath $part -Destination $localPath
  Write-ShaSidecar -ArchivePath $localPath -Sha256 $expectedSha
  Invoke-Ack -Name $Name
  Write-Log "已拉取并确认：$localPath"
  return [pscustomobject]@{ Name = $Name; Sha256 = $expectedSha; SizeBytes = $sizeBytes; Skipped = $false }
}

function Invoke-LocalRetention {
  $archives = @(
    Get-ChildItem -LiteralPath $worldRoot -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^world-\d{8}T\d{6}Z\.tar\.gz$' } |
      Sort-Object Name -Descending
  )
  $kept = @($archives | Select-Object -First $Keep | ForEach-Object { $_.Name })
  foreach ($archive in @($archives | Select-Object -Skip $Keep)) {
    try {
      Remove-Item -Force -LiteralPath $archive.FullName
      Remove-Item -Force -LiteralPath "$($archive.FullName).sha256" -ErrorAction SilentlyContinue
      Write-Log "本地清理旧世界归档：$($archive.Name)"
    } catch {
      Write-Log "警告：本地清理旧世界归档失败（$($archive.Name)）：$($_.Exception.Message)"
    }
  }
  # 清理无对应归档的孤儿旁文件（只匹配本脚本命名的 world-<UTC>.tar.gz.sha256）。
  Get-ChildItem -LiteralPath $worldRoot -File -Filter "world-*.tar.gz.sha256" -ErrorAction SilentlyContinue |
    Where-Object {
      $baseName = $_.Name.Substring(0, $_.Name.Length - 7)
      $baseName -match '^world-\d{8}T\d{6}Z\.tar\.gz$' -and -not (Test-Path -LiteralPath (Join-Path $worldRoot $baseName))
    } |
    ForEach-Object {
      try { Remove-Item -Force -LiteralPath $_.FullName } catch { Write-Log "警告：清理孤儿 .sha256 失败（$($_.Name)）：$($_.Exception.Message)" }
    }
  return $kept
}

# 写远端 world-pull-status.json：本地生成 ASCII JSON → scp 到 /tmp → sudo install 0644。
function Write-RemoteStatus {
  param(
    [bool]$Ok,
    [string]$ErrorMessage,
    [string]$ErrorCode,
    [object[]]$Pulled,
    [object[]]$Kept,
    [int]$PendingRemaining,
    [object]$SourceStatus,
    [string[]]$Warnings
  )
  if ($NoStatusWrite) {
    Write-Log "已跳过远端状态写入（-NoStatusWrite）"
    return
  }
  $pulledNames = @($Pulled | ForEach-Object { $_.Name })
  $lastArchive = if ($pulledNames.Count -gt 0) { $pulledNames[$pulledNames.Count - 1] } else { $null }
  $sizeBytes = [long]0
  foreach ($item in @($Pulled)) { $sizeBytes += [long]$item.SizeBytes }
  # PS 5.1 的哈希表字面量不适合放 if 语句，先算好再组装。
  $lastBackupAt = $null
  $lastBackupOk = $null
  $lastBackupArchive = $null
  if ($SourceStatus) {
    $lastBackupAt = $SourceStatus.lastRunAt
    $lastBackupOk = $SourceStatus.ok
    $lastBackupArchive = $SourceStatus.archiveName
  }
  # 失败/成功统一语义：无错误时 error/message 输出 JSON null，而不是空字符串。
  $errorValue = $null
  if (-not [string]::IsNullOrWhiteSpace($ErrorCode)) { $errorValue = $ErrorCode }
  # 状态文件 0644、应用只读展示：去掉远端/本地绝对路径（AGENTS 红线 #9 / OPS-14），日志保留完整信息。
  $sanitizedMessage = $ErrorMessage
  if (-not [string]::IsNullOrWhiteSpace($sanitizedMessage)) {
    $sanitizedMessage = $sanitizedMessage -replace '[A-Za-z]:\\[^\s"''<>|]+', '<path>'
    $sanitizedMessage = $sanitizedMessage -replace '/(?:var|home|etc|opt|tmp|run|srv|root|mnt|media|Users)/[^\s"''<>|]+', '<path>'
  }
  $messageValue = ConvertTo-AsciiText -Text $sanitizedMessage
  if ([string]::IsNullOrWhiteSpace($messageValue)) { $messageValue = $null }
  $status = [ordered]@{
    lastPullAt        = (Get-Date).ToUniversalTime().ToString("o")
    ok                = $Ok
    archiveName       = $lastArchive
    archiveNames      = @($pulledNames)
    pulledCount       = $pulledNames.Count
    sizeBytes         = $sizeBytes
    kept              = @($Kept)
    keptCount         = @($Kept).Count
    pendingRemaining  = $PendingRemaining
    lastBackupAt      = $lastBackupAt
    lastBackupOk      = $lastBackupOk
    lastBackupArchive = $lastBackupArchive
    error             = $errorValue
    message           = $messageValue
    warnings          = @($Warnings)
  }
  $statusJson = ConvertTo-Json -InputObject $status -Compress -Depth 5
  Write-Utf8NoBom -Path $statusTmp -Content $statusJson
  try {
    $remoteTemp = "/tmp/antifieldcloud-world-pull.json"
    $arguments = @(
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      $statusTmp,
      "${target}:$remoteTemp"
    )
    $upload = Invoke-NativeWithTimeout -FilePath "scp.exe" -Arguments $arguments -TimeoutSeconds $CommandTimeoutSec -Label "scp upload: world-pull-status"
    if ($upload.ExitCode -ne 0) {
      Throw-PullError -Code "status_write_failed" -Message "状态 JSON 上传失败（exit=$($upload.ExitCode)）"
    }
    Invoke-PiSsh -Command "sudo install -o root -g root -m 0644 '$remoteTemp' '$RemoteStatusPath' && rm -f '$remoteTemp'" | Out-Null
    Write-Log "已写入远端拉取状态：$RemoteStatusPath"
  } catch {
    Write-Log "错误：写入远端拉取状态失败：$($_.Exception.Message)"
    throw
  } finally {
    Remove-Item -Force -LiteralPath $statusTmp -ErrorAction SilentlyContinue
  }
}

$script:warnings = @()
$script:pulled = @()
$script:kept = @()

function Invoke-Pull {
  $script:pulled = @()
  $script:kept = @()
  $script:warnings = @()

  if (-not (Test-PiReachable)) {
    Throw-PullError -Code "pi_unreachable" -Message "Pi 直连不可达（${PiHost}:22），请检查网线/地址"
  }
  $snapshot = Get-RemoteSnapshot
  $sourceStatus = $snapshot.Status
  if ($sourceStatus) {
    Write-Log ("远端世界备份状态：ok=$($sourceStatus.ok) lastRunAt=$($sourceStatus.lastRunAt) archiveName=$($sourceStatus.archiveName)")
    if ($sourceStatus.error) { Write-Log "远端上次备份错误码：$($sourceStatus.error) $($sourceStatus.message)" }
  } else {
    $script:warnings += "remote_backup_status_missing"
    Write-Log "警告：未读到远端 world-backup-status.json（可能尚未跑过备份）"
  }

  if ($snapshot.Archives.Count -eq 0) {
    Write-Log "远端没有待拉取的世界归档"
  }
  foreach ($name in $snapshot.Archives) {
    $result = Invoke-PullArchive -Name $name
    $script:pulled += $result
  }

  $script:kept = @(Invoke-LocalRetention)
  $remaining = @()
  try {
    $after = Get-RemoteSnapshot
    $remaining = @($after.Archives)
  } catch {
    $script:warnings += "remote_recheck_failed"
    Write-Log "警告：拉取后复查远端列表失败：$($_.Exception.Message)"
  }
  Write-RemoteStatus -Ok $true -ErrorMessage $null -ErrorCode $null -Pulled $script:pulled -Kept $script:kept -PendingRemaining $remaining.Count -SourceStatus $sourceStatus -Warnings $script:warnings
  Write-Log ("世界备份拉取完成：拉取 $($script:pulled.Count) 个，待拉取 $($remaining.Count) 个，本地保留 $($script:kept.Count) 个")
}

$failureCode = $null
$failureMessage = $null
try {
  Invoke-Pull
  exit 0
} catch {
  $failureMessage = $_.Exception.Message
  $failureCode = "pull_failed"
  if ($null -ne $_.Exception.Data -and $_.Exception.Data.Contains("code")) { $failureCode = [string]$_.Exception.Data["code"] }
  Write-Log "世界备份拉取失败（$failureCode）：$failureMessage"
  try {
    Write-RemoteStatus -Ok $false -ErrorMessage $failureMessage -ErrorCode $failureCode -Pulled $script:pulled -Kept $script:kept -PendingRemaining -1 -SourceStatus $null -Warnings $script:warnings
  } catch {
    Write-Log "错误：失败状态也未能写入远端：$($_.Exception.Message)"
  }
  exit 1
}

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
# 4) 失败保留 pending（下一轮重试同一归档，不重复生成）；重试时跳过本轮已 ack 的归档；
# 5) 状态 JSON 在拉取结束后一次性幂等写入，写失败不触发整轮重试（OP-11）。
# 所有 SSH/SCP 命令都有硬超时，超时用 taskkill /T /F 杀进程树（OP-18），不会无限挂起。
# 依赖：直连网线可达 $PiHost；SSH 公钥已配置；Pi 上已部署 antifieldcloud（迁移 2+）。
$ErrorActionPreference = "Stop"
# OP-06：远端为 UTF-8；PS 5.1 默认按 GBK 解码 ssh 输出会让中文 JSON 解析失败。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$target = "$PiUser@$PiHost"
$base = Join-Path $env:LOCALAPPDATA "AntifieldCloud"
$destRoot = $BackupRoot
$logPath = Join-Path $base "backup.log"
$statusTmp = Join-Path $env:TEMP ("antifieldcloud-pull-" + [guid]::NewGuid().ToString("N") + ".json")
New-Item -ItemType Directory -Force -Path $base, (Join-Path $destRoot "daily"), (Join-Path $destRoot "weekly"), (Join-Path $destRoot "secrets") | Out-Null

# 本轮已 ack 的归档：重试时跳过，避免重复下载/重复 ack 造成歧义（OP-11）。
$script:ackedArchives = @{}

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

# 把参数数组拼成 Windows 命令行字符串（PS 5.1 的 Start-Process 只接受字符串）。
function ConvertTo-ArgumentString {
  param([string[]]$Arguments)
  $quoted = foreach ($argument in $Arguments) {
    if ($argument -match '[\s"]') { '"' + ($argument -replace '"', '\"') + '"' } else { $argument }
  }
  return ($quoted -join " ")
}

# 执行本地进程并硬超时：超时用 taskkill /T /F 杀整棵进程树（OP-18），不会只杀父进程。
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
      throw "命令超时（${TimeoutSeconds}s，已杀进程树）：$Label"
    }
    $stdoutRaw = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw -Encoding UTF8 -ErrorAction SilentlyContinue } else { $null }
    $stderrRaw = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw -Encoding UTF8 -ErrorAction SilentlyContinue } else { $null }
    # Get-Content -Raw 对空文件返回 AutomationNull，需显式归一化为空串。
    $stdoutText = if ($null -eq $stdoutRaw) { "" } else { [string]$stdoutRaw }
    $stderrText = if ($null -eq $stderrRaw) { "" } else { [string]$stderrRaw }
    $exitCode = if ($null -eq $process.ExitCode) { -1 } else { [int]$process.ExitCode }
    return [pscustomobject]@{
      Label    = $Label
      ExitCode = $exitCode
      Output   = ((@($stdoutText, $stderrText) -join "`n").Trim())
    }
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
  $jsonLines = @(($output -split "`r?`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\{.*\}$' })
  if ($jsonLines.Count -eq 0) { throw "远端命令没有返回 JSON：$output" }
  $candidate = $jsonLines[$jsonLines.Count - 1]
  try {
    return ($candidate | ConvertFrom-Json)
  } catch {
    # 兜底：远端日志/本地化提示若混入非 ASCII，先剥离再解析（OP-06），仍失败才报错。
    $asciiOnly = -join ($candidate.ToCharArray() | Where-Object { [int]$_ -ge 32 -and [int]$_ -lt 127 })
    try {
      return ($asciiOnly | ConvertFrom-Json)
    } catch {
      throw "远端 JSON 解析失败：$candidate"
    }
  }
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

# 写状态 JSON：ok 仅在文件归档成功且密钥包明确成功/跳过时为 true；失败路径写 error 字段。
# 由调用方在拉取结束后一次性调用并包裹 try/catch：写失败只记错误，不触发整轮重试（OP-11）。
function Write-PiStatus {
  param([int]$PendingRemaining, [bool]$Ok = $true, [string]$ErrorMessage = $null)
  $secretsFailed = ($script:secretsState.attempted -and ($script:secretsState.ok -eq $false))
  $status = @{
    lastPullAt          = (Get-Date).ToUniversalTime().ToString("o")
    sizeBytes           = [long]$script:lastArchiveBytes
    ok                  = ($Ok -and (-not $secretsFailed))
    archiveName         = $script:lastArchiveName
    mode                = $script:lastArchiveMode
    pendingRemaining    = $PendingRemaining
    secretsAttempted    = [bool]$script:secretsState.attempted
    secretsOk           = $script:secretsState.ok
    secretsLastError    = $script:secretsState.lastError
    lastSecretsAt       = $script:secretsState.lastSuccessAt
    secretsArchiveName  = $script:secretsState.archiveName
    error               = $ErrorMessage
  } | ConvertTo-Json -Compress -Depth 4
  [System.IO.File]::WriteAllText($statusTmp, $status, (New-Object System.Text.UTF8Encoding($false)))
  Copy-ToPi $statusTmp "/tmp/antifieldcloud-pull.json"
  Invoke-PiSsh "sudo install -o antifieldcloud -g antifieldcloud -m 0644 /tmp/antifieldcloud-pull.json /var/lib/antifieldcloud/backup-pull.json" | Out-Null
  Invoke-PiSsh "sudo rm -f /tmp/antifieldcloud-pull.json" | Out-Null
}

# 密钥包拉取：独立 try/状态，失败只记录并在状态 JSON 中可见，不影响文件归档已成功的事实。
# OP-16：拉到本地并校验成功后，Pi 上保留最新 1 份（backup-secrets.sh 的 KEEP=2 负责滚动），
# 不再立即删除远端归档；这样网络/PC 故障时仍有一份可重试的密钥包。
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
    # 不删除远端：Pi 由 backup-secrets.sh 的保留策略滚动最新 2 份，PC 失败时可复用同一份（OP-16）。
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
    $prepared = Invoke-RemoteJson "timeout -k 30 3300 $cli --prepare $fullArg --no-warnings" -Attempts 1 -TimeoutSeconds $PrepareTimeoutSec
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
    # 重试窗口内已成功 ack 的归档直接跳过，避免重复下载旧 pending（OP-11）。
    if ($script:ackedArchives.ContainsKey($name)) {
      Write-Log "本轮已确认，跳过：$name"
      continue
    }
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

    $ack = Invoke-RemoteJson "timeout -k 10 900 $cli --ack '$name' --sha256 '$sha' --no-warnings" -TimeoutSeconds (Get-DownloadTimeout $size)
    if (-not $ack.ok) { throw "ack 失败：$($ack.error)" }
    $script:ackedArchives[$name] = $true
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

$pullOk = $false
for ($attempt = 1; $attempt -le 3; $attempt++) {
  try {
    Invoke-Pull
    $pullOk = $true
    break
  } catch {
    Write-Log "第 $attempt 次尝试失败：$($_.Exception.Message)"
    if ($attempt -lt 3) { Start-Sleep -Seconds 60 }
  }
}

# 状态 JSON 在重试循环外一次性写入：写失败不触发再次 prepare（避免重复 pending），
# 失败时也尝试写 ok=false 便于面板/告警看到（OP-11）。
$statusOk = $pullOk
$pullError = if ($pullOk) { $null } else { "pull_failed" }
$pendingRemaining = -1
$cli = "sudo -u antifieldcloud -H /usr/local/bin/node /opt/antifieldcloud/current/scripts/backup.mjs"
try {
  $after = Invoke-RemoteJson "$cli --pending --no-warnings"
  $pendingRemaining = [int]$after.count
} catch {
  Write-Log "警告：拉取后复查 pending 失败：$($_.Exception.Message)"
}
if ($script:secretsState.attempted -and ($script:secretsState.ok -eq $false)) {
  $statusOk = $false
  if (-not $pullError) { $pullError = "secrets_pull_failed" }
}
try {
  Write-PiStatus -PendingRemaining $pendingRemaining -Ok $statusOk -ErrorMessage $pullError
} catch {
  Write-Log "错误：状态 JSON 写入失败（不重试拉取）：$($_.Exception.Message)"
  $statusOk = $false
}
if (-not $statusOk) {
  Write-Log "备份未完全成功：请检查直连网线、Pi 状态、备份空间、pending 归档或密钥包。"
  exit 1
}
Write-Log "备份成功：$($script:lastArchiveBytes) bytes（secrets=$(if ($script:secretsState.ok -eq $true) { 'ok' } else { 'skipped' })）"
exit 0
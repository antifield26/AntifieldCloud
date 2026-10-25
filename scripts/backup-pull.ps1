param(
  [string]$PiHost = "192.0.2.10",
  [string]$PiUser = "antifield",
  [string]$BackupRoot = (Join-Path $env:USERPROFILE "AntifieldCloudBackups"),
  [switch]$SkipSecrets,
  [switch]$IncludeHostConfig,
  [string]$AgeIdentityPath = "",
  [switch]$DisableLock,
  [int]$CommandTimeoutSec = 60,
  [int]$PrepareTimeoutSec = 3600,
  [int]$SecretsTimeoutSec = 300
)

# 每日由 Windows 计划任务调用：两阶段备份协议 + 密钥包。
# 1) 查询 Pi 上 pending 归档；没有 pending 才触发 --prepare 生成新归档；
# 2) 逐个下载到 .part → SHA-256 校验（密文归档按密文 SHA）→ 原子改名 → 写 .sha256 旁文件
#    →（可选 -AgeIdentityPath）解密校验 plainSha256/plainSize 后删除临时明文 → --ack → 删除 Pi 归档/旁文件；
# 3) 加密归档（.tar.gz.age）必须同时有 <name>.meta.json（plainSha256/plainSize/encryptedWith），缺失即失败；
# 4) 密钥包独立步骤，成功/失败都写入状态 JSON；`includesOpencode` 必须为 true（缺 opencode DB 视为失败）；
# 5) 失败保留 pending（下一轮重试同一归档，不重复生成）；重试时跳过本轮已 ack 的归档；
# 6) 状态 JSON 在拉取结束后一次性幂等写入，写失败不触发整轮重试（OP-11）；状态中的错误文本会脱敏路径；
# 7) 本地锁文件防同日重复运行（计划任务另有 IgnoreNew；手动运行也会被锁挡住）。
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
  attempted        = $false
  ok               = $null
  lastError        = $null
  lastSuccessAt    = $null
  archiveName      = $null
  includesOpencode = $null
}
$script:lastArchiveName = ""
$script:lastArchiveMode = ""
$script:lastArchiveBytes = [long]0
$script:lastArchiveEncrypted = $false
$script:lastPlainVerified = $null
$script:lastIncludesHostConfig = $false
# 加密归档缺失/损坏的 sidecar：不 ack、不删远端，留待下次/人工；整批按 DATA-01 继续处理其它归档。
$script:sidecarMissing = New-Object System.Collections.Generic.List[string]
$script:lockPath = Join-Path $base "backup-pull.lock"
$script:lockAcquired = $false

function Write-Log {
  param([string]$Message)
  $line = "{0} {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -Path $logPath -Value $line -Encoding UTF8
  Write-Host $line
}

# 状态 JSON 中只写脱敏后的错误文本：去掉 PC/远端绝对路径，避免状态文件泄露本机目录结构（OPS-14/OPS-20）。
function ConvertTo-StatusMessage {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
  $cleaned = $Text
  $cleaned = $cleaned -replace '[A-Za-z]:\\[^\s"''<>|]+', '<path>'
  $cleaned = $cleaned -replace '/(?:var|home|etc|opt|tmp|run|srv|root|mnt|media)/[^\s"''<>|]+', '<path>'
  $cleaned = $cleaned -replace '\s+', ' '
  return $cleaned.Trim()
}

# 本地互斥锁：防止手动运行与计划任务重叠（计划任务本身 IgnoreNew，但手动运行不受其约束）。
# 锁超过 6 小时视为陈旧（崩溃/断电残留），可接管并记日志。
function Enter-PullLock {
  if (Test-Path -LiteralPath $script:lockPath) {
    $ageHours = ((Get-Date) - (Get-Item -LiteralPath $script:lockPath).LastWriteTime).TotalHours
    if ($ageHours -lt 6) {
      throw "已有备份任务在运行（锁 $($script:lockPath)，$([Math]::Round($ageHours, 1))h）；如确认无运行可删除该锁文件或使用 -DisableLock"
    }
    Write-Log "检测到陈旧锁（$([Math]::Round($ageHours, 1))h），接管"
  }
  [System.IO.File]::WriteAllText(
    $script:lockPath,
    ("pid={0}`nstartedAt={1}`n" -f $PID, (Get-Date).ToUniversalTime().ToString("o")),
    (New-Object System.Text.UTF8Encoding($false))
  )
  $script:lockAcquired = $true
}

function Exit-PullLock {
  if ($script:lockAcquired -and (Test-Path -LiteralPath $script:lockPath)) {
    Remove-Item -LiteralPath $script:lockPath -Force -ErrorAction SilentlyContinue
  }
  $script:lockAcquired = $false
}

# 加密归档的可选离线校验：用 -AgeIdentityPath 解密到临时文件，比对 meta 的 plainSha256/plainSize 后立即删除。
# 私钥路径/明文内容不写日志、不写状态；只报告成功/失败与错误码。
function Test-EncryptedArchive {
  param([string]$CipherPath, [string]$MetaPath)
  if ([string]::IsNullOrWhiteSpace($AgeIdentityPath)) { return $null }
  if (-not (Test-Path -LiteralPath $AgeIdentityPath)) { throw "age 私钥文件不存在：$AgeIdentityPath" }
  $ageCommand = Get-Command age -ErrorAction SilentlyContinue
  if (-not $ageCommand) { throw "找不到 age（解密校验需要 age 在 PATH 中）" }
  if (-not (Test-Path -LiteralPath $MetaPath)) { throw "缺少加密归档元数据：$MetaPath" }
  try {
    $meta = ([System.IO.File]::ReadAllText($MetaPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json)
  } catch {
    throw "加密归档元数据不是合法 JSON：$MetaPath"
  }
  $plainSha = ([string]$meta.plainSha256).ToLower()
  $plainSize = [long]$meta.plainSize
  if ($plainSha -notmatch '^[0-9a-f]{64}$' -or $plainSize -le 0) { throw "加密归档元数据缺 plainSha256/plainSize" }
  $tmpPlain = Join-Path $env:TEMP ("antifieldcloud-plain-" + [guid]::NewGuid().ToString("N") + ".tar.gz")
  try {
    $size = (Get-Item -LiteralPath $CipherPath).Length
    $result = Invoke-NativeWithTimeout -FilePath $ageCommand.Source -Arguments @(
      "-d", "-i", $AgeIdentityPath, "-o", $tmpPlain, $CipherPath
    ) -TimeoutSeconds (Get-DownloadTimeout $size) -Label "age -d"
    if ($result.ExitCode -ne 0) { throw "age 解密失败（exit=$($result.ExitCode)）" }
    $actualSha = Get-LocalHash $tmpPlain
    $actualSize = (Get-Item -LiteralPath $tmpPlain).Length
    if ($actualSha -ne $plainSha -or $actualSize -ne $plainSize) {
      throw "解密后明文校验失败（sha/size 与 meta.json 不一致）"
    }
    Write-Log "加密归档解密校验通过：$([System.IO.Path]::GetFileName($CipherPath))"
    return $true
  } finally {
    if (Test-Path -LiteralPath $tmpPlain) { Remove-Item -LiteralPath $tmpPlain -Force -ErrorAction SilentlyContinue }
  }
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
  # 明文与 v0.7.0 加密归档（.tar.gz.age）都允许；文件名由 Pi 侧 CLI 生成，仍做白名单校验防路径注入。
  if ($Name -notmatch '^snapshot-[0-9TZ]+(-[0-9]+)?-(full|inc)\.tar\.gz(\.age)?$') { throw "归档名异常：$Name" }
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
  param([int]$PendingRemaining, [bool]$Ok = $true, [string]$ErrorMessage = $null, [string]$ErrorDetail = $null)
  $secretsFailed = ($script:secretsState.attempted -and ($script:secretsState.ok -eq $false))
  $status = @{
    lastPullAt          = (Get-Date).ToUniversalTime().ToString("o")
    sizeBytes           = [long]$script:lastArchiveBytes
    ok                  = ($Ok -and (-not $secretsFailed))
    archiveName         = $script:lastArchiveName
    mode                = $script:lastArchiveMode
    encrypted           = [bool]$script:lastArchiveEncrypted
    plainVerified       = $script:lastPlainVerified
    sidecarMissing      = $script:sidecarMissing.Count
    pendingRemaining    = $PendingRemaining
    secretsAttempted    = [bool]$script:secretsState.attempted
    secretsOk           = $script:secretsState.ok
    secretsLastError    = (ConvertTo-StatusMessage $script:secretsState.lastError)
    lastSecretsAt       = $script:secretsState.lastSuccessAt
    secretsArchiveName  = $script:secretsState.archiveName
    secretsIncludesOpencode = $script:secretsState.includesOpencode
    includesHostConfig  = [bool]$script:lastIncludesHostConfig
    error               = $ErrorMessage
    errorDetail         = (ConvertTo-StatusMessage $ErrorDetail)
  } | ConvertTo-Json -Compress -Depth 4
  [System.IO.File]::WriteAllText($statusTmp, $status, (New-Object System.Text.UTF8Encoding($false)))
  # 远端临时文件用随机名，避免手动并发运行互相覆盖（OPS-20）。
  $remoteTmp = "/tmp/antifieldcloud-pull-{0}.json" -f ([guid]::NewGuid().ToString("N").Substring(0, 12))
  Copy-ToPi $statusTmp $remoteTmp
  Invoke-PiSsh "sudo install -o antifieldcloud -g antifieldcloud -m 0644 '$remoteTmp' /var/lib/antifieldcloud/backup-pull.json" | Out-Null
  Invoke-PiSsh "sudo rm -f '$remoteTmp'" | Out-Null
}

# 密钥包拉取：独立 try/状态，失败只记录并在状态 JSON 中可见，不影响文件归档已成功的事实。
# OP-16：拉到本地并校验成功后，Pi 上保留最新 1 份（backup-secrets.sh 的 KEEP=2 负责滚动），
# 不再立即删除远端归档；这样网络/PC 故障时仍有一份可重试的密钥包。
function Invoke-SecretsPull {
  $script:secretsState.attempted = $true
  $script:secretsState.ok = $null
  $script:secretsState.lastError = $null
  $script:secretsState.includesOpencode = $null
  $scriptPath = "/opt/antifieldcloud/current/scripts/backup-secrets.sh"
  try {
    $exists = (Invoke-PiSsh "test -f '$scriptPath' && echo YES || echo NO" -TimeoutSeconds 30) -join ""
    if ($exists -notmatch "YES") {
      $script:secretsState.attempted = $false
      $script:secretsState.lastError = "Pi 上未安装 backup-secrets.sh"
      Write-Log "跳过密钥备份：$($script:secretsState.lastError)"
      return
    }
    $secretsFlags = if ($IncludeHostConfig) { " --include-host-config" } else { "" }
    $meta = Invoke-RemoteJson "sudo /usr/bin/timeout -k 10 300 bash '$scriptPath'$secretsFlags" -TimeoutSeconds $SecretsTimeoutSec
    if (-not $meta.ok) { throw "密钥备份失败：$($meta.error)" }
    $name = [string]$meta.archiveName
    if ($name -notmatch '^secrets-[0-9TZ-]+\.tar\.age$') { throw "密钥归档名异常：$name" }
    $sha = ([string]$meta.sha256).ToLower()
    if ($sha -notmatch '^[0-9a-f]{64}$') { throw "密钥归档 SHA 异常：$name" }
    $size = [long]$meta.sizeBytes
    # OPS-03：opencode 已安装时密钥包必须包含 DB；PC 侧拒绝把“缺失 opencode DB”当作成功。
    if ($meta.includesOpencode -ne $true) { throw "密钥包未包含 opencode DB（includesOpencode=$($meta.includesOpencode)）" }
    $script:secretsState.includesOpencode = $true
    $script:lastIncludesHostConfig = [bool]$meta.includesHostConfig
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
    Write-Log "密钥备份已拉取：$local（includesOpencode=true，hostConfig=$($script:lastIncludesHostConfig)）"
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
      encrypted = [bool]$prepared.encrypted; archiveFormat = [string]$prepared.archiveFormat
      metaName = if ($prepared.metaName) { [string]$prepared.metaName } else { $null }
      metaExists = $null
    })
  } else {
    Write-Log "发现 $($pending.count) 个 pending 归档，继续拉取"
    if ($pending.missingSidecars) {
      foreach ($missing in @($pending.missingSidecars)) { Write-Log "远端警告：加密归档缺 .meta.json，本轮不 ack：$missing" }
    }
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
    $isEncrypted = $name.EndsWith(".age")

    $folder = if ($mode -eq "full") { "weekly" } else { "daily" }
    $dateDir = Join-Path (Join-Path $destRoot $folder) (Get-Date).ToString("yyyy-MM-dd")
    New-Item -ItemType Directory -Force -Path $dateDir | Out-Null
    $localPath = Join-Path $dateDir $name
    $localMeta = "$localPath.meta.json"
    $remoteMeta = ""

    if (Test-Path $localPath) {
      if ((Get-LocalHash $localPath) -ne $sha) {
        Write-Log "本地归档哈希不符，重新下载：$name"
        Remove-Item -Force $localPath -ErrorAction SilentlyContinue
      }
    }
    # 加密归档必须同时拉 .age + <archive>.meta.json（Lead CLI 契约）：
    # 先校验密文 SHA/大小（与 pending 的 sha256/sizeBytes），再可选解密校验 plainSha256/plainSize。
    # sidecar 缺失/损坏：不 ack、不删远端，记录 sidecarMissing 后继续处理其它归档（DATA-01）。
    if ($isEncrypted) {
      $metaName = "$name.meta.json"
      if ($archive.PSObject.Properties['metaName'] -and $archive.metaName) { $metaName = [string]$archive.metaName }
      if ($metaName -notmatch '^snapshot-[0-9TZ]+(-[0-9]+)?-(full|inc)\.tar\.gz\.age\.meta\.json$') {
        $script:sidecarMissing.Add($name)
        Write-Log "加密归档 sidecar 名称非法，跳过（不 ack）：$name（metaName=$metaName）"
        continue
      }
      if ($archive.PSObject.Properties['metaExists'] -and $archive.metaExists -eq $false) {
        $script:sidecarMissing.Add($name)
        Write-Log "加密归档缺 .meta.json，跳过（不 ack，留待下次/人工）：$name"
        continue
      }
      $remoteMeta = "/var/lib/antifieldcloud/backups/$metaName"
      try {
        $metaPart = Copy-FromPi $remoteMeta $localMeta 0
      } catch {
        $script:sidecarMissing.Add($name)
        Write-Log "加密归档 sidecar 下载失败，跳过（不 ack）：$name（$($_.Exception.Message)）"
        continue
      }
      try {
        $metaJson = ([System.IO.File]::ReadAllText($metaPart, [System.Text.Encoding]::UTF8) | ConvertFrom-Json)
      } catch {
        Remove-Item -Force $metaPart -ErrorAction SilentlyContinue
        $script:sidecarMissing.Add($name)
        Write-Log "加密归档 sidecar 不是合法 JSON，跳过（不 ack）：$metaName"
        continue
      }
      $metaError = $null
      if ([int]$metaJson.schema -ne 2) { $metaError = "schema!=2" }
      elseif ([string]$metaJson.name -ne $name) { $metaError = "name 不匹配" }
      elseif ([string]$metaJson.mode -ne $mode) { $metaError = "mode 不匹配" }
      elseif ([string]$metaJson.archiveFormat -ne "tar.gz.age") { $metaError = "archiveFormat!=tar.gz.age" }
      elseif ($metaJson.encrypted -ne $true) { $metaError = "encrypted!=true" }
      elseif ([string]$metaJson.encryptedWith -ne "age") { $metaError = "encryptedWith!=age" }
      elseif (([string]$metaJson.recipient) -notmatch '^age1[0-9a-z]{16,}$') { $metaError = "recipient 非法" }
      elseif (([string]$metaJson.plainSha256) -notmatch '^[0-9a-fA-F]{64}$') { $metaError = "plainSha256 非法" }
      elseif ([long]$metaJson.plainSize -lt 0) { $metaError = "plainSize 非法" }
      elseif (([string]$metaJson.cipherSha256) -notmatch '^[0-9a-fA-F]{64}$') { $metaError = "cipherSha256 非法" }
      elseif ([long]$metaJson.cipherSize -le 0) { $metaError = "cipherSize 非法" }
      elseif (([string]$metaJson.cipherSha256).ToLower() -ne $sha) { $metaError = "cipherSha256 与 pending 不一致" }
      elseif ([long]$metaJson.cipherSize -ne $size) { $metaError = "cipherSize 与 pending 不一致" }
      if ($metaError) {
        Remove-Item -Force $metaPart -ErrorAction SilentlyContinue
        $script:sidecarMissing.Add($name)
        Write-Log "加密归档 sidecar 校验失败，跳过（不 ack）：$metaName（$metaError）"
        continue
      }
      Move-Item -Force $metaPart $localMeta
    }
    if (-not (Test-Path $localPath)) {
      Write-Log "下载 $name（$size bytes，encrypted=$isEncrypted）"
      $part = Copy-FromPi $remote $localPath $size
      if ((Get-LocalHash $part) -ne $sha) {
        Remove-Item -Force $part -ErrorAction SilentlyContinue
        throw "SHA-256 校验失败：$name（远端记录 $sha）"
      }
      Move-Item -Force $part $localPath
    }
    Write-ShaSidecar $localPath $sha
    $plainVerified = $null
    if ($isEncrypted) {
      if (-not [string]::IsNullOrWhiteSpace($AgeIdentityPath)) {
        $plainVerified = Test-EncryptedArchive -CipherPath $localPath -MetaPath $localMeta
      } else {
        Write-Log "未提供 -AgeIdentityPath：仅做密文 SHA 校验，跳过 plainSha 解密校验"
      }
    }

    $ack = Invoke-RemoteJson "timeout -k 10 900 $cli --ack '$name' --sha256 '$sha' --no-warnings" -TimeoutSeconds (Get-DownloadTimeout $size)
    if (-not $ack.ok) { throw "ack 失败：$($ack.error)" }
    $script:ackedArchives[$name] = $true
    try {
      $deletePaths = "'$remote' '$remote.sha256'"
      if ($isEncrypted -and $remoteMeta) { $deletePaths += " '$remoteMeta'" }
      Invoke-PiSsh "sudo rm -f $deletePaths" | Out-Null
    } catch {
      Write-Log "警告：远端归档删除失败（下次 ack 会按保留策略清理）：$($_.Exception.Message)"
    }
    $script:lastArchiveBytes += $size
    $script:lastArchiveName = $name
    $script:lastArchiveMode = $mode
    $script:lastArchiveEncrypted = $isEncrypted
    $script:lastPlainVerified = $plainVerified
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

# 本地互斥（计划任务 IgnoreNew 只覆盖任务自身；手动/重复运行仍需要锁）。
if (-not $DisableLock) { Enter-PullLock }

$pullOk = $false
$pullErrorDetail = $null
for ($attempt = 1; $attempt -le 3; $attempt++) {
  try {
    Invoke-Pull
    $pullOk = $true
    break
  } catch {
    $pullErrorDetail = $_.Exception.Message
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
# sidecar 缺失/损坏不阻断其它归档处理，但整轮标记为未完全成功（不 ack、不删远端，留待重试/人工）。
if ($script:sidecarMissing.Count -gt 0) {
  $statusOk = $false
  if (-not $pullError) { $pullError = "sidecar_missing" }
  if (-not $pullErrorDetail) { $pullErrorDetail = "加密归档 sidecar 缺失/损坏 $($script:sidecarMissing.Count) 个（未 ack，留待下次/人工）" }
}
try {
  Write-PiStatus -PendingRemaining $pendingRemaining -Ok $statusOk -ErrorMessage $pullError -ErrorDetail $pullErrorDetail
} catch {
  Write-Log "错误：状态 JSON 写入失败（不重试拉取）：$($_.Exception.Message)"
  $statusOk = $false
}
Exit-PullLock
Remove-Item -LiteralPath $statusTmp -Force -ErrorAction SilentlyContinue
if (-not $statusOk) {
  Write-Log "备份未完全成功：请检查直连网线、Pi 状态、备份空间、pending 归档或密钥包。"
  exit 1
}
Write-Log "备份成功：$($script:lastArchiveBytes) bytes（secrets=$(if ($script:secretsState.ok -eq $true) { 'ok' } else { 'skipped' })）"
exit 0
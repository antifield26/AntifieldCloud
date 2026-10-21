param(
  [string]$PiHost = "192.0.2.10",
  [string]$PiUser = "antifield",
  [string]$AppUrl = "https://app.example.com",
  [string]$AiUrl = "https://ai.example.com",
  [string]$BackupRoot = (Join-Path $env:USERPROFILE "AntifieldCloudBackups"),
  [switch]$SkipPublic,
  [switch]$SkipLocalBackup,
  [switch]$SkipScriptHash,
  [string]$ExpectedVersion = "",
  [int]$ExpectedSchemaVersion = 0,
  [string]$AccessClientId = "",
  [string]$AccessClientSecret = ""
)

# 部署后冒烟（只读）：公网 HTTPS、PWA/分享/告警端点、Pi 本机服务/版本、内存 cgroup、nftables、
# systemctl --failed、备份 pending/拉取状态/密钥包状态、世界备份与世界拉取状态、演练状态、
# 已安装脚本 SHA-256 与本地仓库一致性；本地 .sha256 旁文件可 -SkipLocalBackup 跳过。
# 所有 SSH 命令带重试与硬超时（Start-Process + taskkill /T /F）；只读，不修改 Pi 状态。
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$target = "$PiUser@$PiHost"
$script:pass = 0
$script:fail = 0
$script:warn = 0
$root = Split-Path -Parent $PSScriptRoot

function Check {
  param([string]$Name, [scriptblock]$Action)
  try {
    $result = & $Action
    if ($result -eq $false) { throw "返回值 false" }
    Write-Host ("PASS  {0}  {1}" -f $Name, $result) -ForegroundColor Green
    $script:pass++
  } catch {
    Write-Host ("FAIL  {0}  {1}" -f $Name, $_.Exception.Message) -ForegroundColor Red
    $script:fail++
  }
}

function Warn {
  param([string]$Name, [string]$Message)
  Write-Host ("WARN  {0}  {1}" -f $Name, $Message) -ForegroundColor Yellow
  $script:warn++
}

function ConvertTo-ArgumentString {
  param([string[]]$Arguments)
  $quoted = foreach ($argument in $Arguments) {
    if ($argument -match '[\s"]') { '"' + ($argument -replace '"', '\"') + '"' } else { $argument }
  }
  return ($quoted -join " ")
}

function Invoke-NativeWithTimeout {
  param([string]$FilePath, [string[]]$Arguments, [int]$TimeoutSeconds, [string]$Label)
  $stdoutPath = [System.IO.Path]::GetTempFileName()
  $stderrPath = [System.IO.Path]::GetTempFileName()
  $commandLine = ConvertTo-ArgumentString -Arguments $Arguments
  try {
    $process = Start-Process -FilePath $FilePath -ArgumentList $commandLine -PassThru -NoNewWindow `
      -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    # PS 5.1：Start-Process -PassThru 必须缓存 Handle 后 WaitForExit，ExitCode 才有值。
    $null = $process.Handle
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      try { & taskkill.exe /T /F /PID $process.Id 2>&1 | Out-Null } catch { try { $process.Kill() } catch { } }
      throw "命令超时（${TimeoutSeconds}s，已杀进程树）：$Label"
    }
    $stdoutRaw = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw -Encoding UTF8 -ErrorAction SilentlyContinue } else { $null }
    $stderrRaw = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw -Encoding UTF8 -ErrorAction SilentlyContinue } else { $null }
    $stdoutText = if ($null -eq $stdoutRaw) { "" } else { [string]$stdoutRaw }
    $stderrText = if ($null -eq $stderrRaw) { "" } else { [string]$stderrRaw }
    $exitCode = if ($null -eq $process.ExitCode) { -1 } else { [int]$process.ExitCode }
    return [pscustomobject]@{
      ExitCode = $exitCode
      StdOut   = $stdoutText.Trim()
      StdErr   = $stderrText.Trim()
      Output   = ((@($stdoutText, $stderrText) -join "`n").Trim())
    }
  } finally {
    Remove-Item -Force $stdoutPath, $stderrPath -ErrorAction SilentlyContinue
  }
}

# SSH 检查统一重试 3 次、每次硬超时；只读命令，不修改 Pi 状态。
function Invoke-PiSsh {
  param([string]$Command, [int]$Attempts = 3, [int]$TimeoutSeconds = 60)
  $lastResult = $null
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    $lastResult = Invoke-NativeWithTimeout -FilePath "ssh.exe" -Arguments @(
      "-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=2", $target, $Command
    ) -TimeoutSeconds $TimeoutSeconds -Label "ssh: $Command"
    if ($lastResult.ExitCode -eq 0) { return $lastResult.Output }
    if ($attempt -eq $Attempts) { throw "ssh exit=$($lastResult.ExitCode)：$($lastResult.Output)" }
    Start-Sleep -Seconds 5
  }
}

function Get-HttpStatus {
  param([string]$Url, [string[]]$ExtraArgs = @())
  return (& curl.exe -sS -o NUL -w "%{http_code}" --max-time 20 @ExtraArgs $Url 2>&1 | Out-String).Trim()
}

function Get-HttpHeaders {
  param([string]$Url, [string[]]$ExtraArgs = @())
  return (& curl.exe -sS -D - -o NUL --max-time 20 @ExtraArgs $Url 2>&1 | Out-String)
}

# Cloudflare Access service token（可选）：仅当 Id/Secret 同时提供时附加请求头；
# 不输出凭据本身，避免 CI/日志泄漏。未配置 Access 时传了也无害（边缘忽略）。
function Get-AccessCurlArgs {
  if ($AccessClientId -and $AccessClientSecret) {
    return @('-H', "CF-Access-Client-Id: $AccessClientId", '-H', "CF-Access-Client-Secret: $AccessClientSecret")
  }
  return @()
}

if ($AccessClientId -xor $AccessClientSecret) {
  throw 'Access 凭据必须同时提供 -AccessClientId 与 -AccessClientSecret'
}

# 解析 JSON：忽略日志/提示行；失败时剥离非 ASCII 再试一次（OP-06）。
function ConvertFrom-JsonText {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
  $lines = @($Text -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\{.*\}$' })
  if ($lines.Count -eq 0) { return $null }
  $candidate = $lines[$lines.Count - 1]
  try { return ($candidate | ConvertFrom-Json) } catch { }
  $asciiOnly = -join ($candidate.ToCharArray() | Where-Object { [int]$_ -ge 32 -and [int]$_ -lt 127 })
  try { return ($asciiOnly | ConvertFrom-Json) } catch { return $null }
}

# 读取远端 JSON 文件；文件缺失返回 $null（由调用方决定 PASS/WARN）。
function Get-PiJsonFile {
  param([string]$Path, [int]$TimeoutSeconds = 30)
  $text = (Invoke-PiSsh "cat '$Path' 2>/dev/null || echo '__MISSING__'" -TimeoutSeconds $TimeoutSeconds | Out-String).Trim()
  if ($text -eq "__MISSING__" -or $text -eq "") { return $null }
  return (ConvertFrom-JsonText $text)
}

# 计算 ISO 时间的年龄（小时）；解析失败返回 $null。
function Get-StampAgeHours {
  param([object]$Value)
  if (-not $Value) { return $null }
  try {
    $styles = [System.Globalization.DateTimeStyles]::AdjustToUniversal -bor [System.Globalization.DateTimeStyles]::AssumeUniversal
    $timestamp = ([datetime]::Parse([string]$Value, [System.Globalization.CultureInfo]::InvariantCulture, $styles)).ToUniversalTime()
    return ((Get-Date).ToUniversalTime() - $timestamp).TotalHours
  } catch {
    return $null
  }
}

if (-not $SkipPublic) {
  $accessArgs = Get-AccessCurlArgs
  Check "公网 app 健康检查" {
    $code = Get-HttpStatus "$AppUrl/healthz" -ExtraArgs $accessArgs
    if ($code -ne "200") { throw "HTTP $code" }
    "HTTP 200"
  }
  if ($accessArgs.Count -gt 0) {
    Check "Cloudflare Access service token" {
      $code = Get-HttpStatus "$AppUrl/api/bots/status" -ExtraArgs $accessArgs
      if ($code -ne "401") { throw "HTTP $code（预期 401：带 Access token 后到达应用但未登录）" }
      "HTTP 401（Access 通过、应用鉴权生效）"
    }
  }
  Check "公网 ai 登录跳转/401" {
    $code = Get-HttpStatus "$AiUrl/" -ExtraArgs $accessArgs
    if ($code -ne "302" -and $code -ne "401") { throw "HTTP $code" }
    "HTTP $code"
  }
  Check "公网安全响应头" {
    $headers = Get-HttpHeaders "$AppUrl/" -ExtraArgs $accessArgs
    $required = @(
      @{ Name = "content-security-policy"; Pattern = "default-src" },
      @{ Name = "x-content-type-options"; Pattern = "nosniff" },
      @{ Name = "referrer-policy"; Pattern = "no-referrer" },
      @{ Name = "strict-transport-security"; Pattern = "max-age=" }
    )
    foreach ($item in $required) {
      if ($headers -notmatch ("(?im)^" + [regex]::Escape($item.Name) + ":\s*" + $item.Pattern)) {
        throw "缺少/不匹配响应头：$($item.Name)"
      }
    }
    "CSP/nosniff/referrer/HSTS OK"
  }
  Check "PWA manifest/sw/offline" {
    foreach ($path in @("/manifest.webmanifest", "/sw.js", "/offline.html")) {
      $code = Get-HttpStatus "$AppUrl$path" -ExtraArgs $accessArgs
      if ($code -ne "200") { throw "$path HTTP $code" }
    }
    "manifest+sw+offline 200"
  }
  Check "公开分享页 404/410" {
    $code = Get-HttpStatus "$AppUrl/s/antifieldcloud-smoke-invalid-token" -ExtraArgs $accessArgs
    if ($code -ne "404" -and $code -ne "410") { throw "HTTP $code（预期 404/410）" }
    "HTTP $code"
  }
  Check "告警 API 未登录 401" {
    $code = Get-HttpStatus "$AppUrl/api/alerts" -ExtraArgs $accessArgs
    if ($code -ne "401") { throw "HTTP $code" }
    "HTTP 401"
  }
}

Check "Pi SSH 可达" {
  $out = Invoke-PiSsh "echo ok" -Attempts 1
  ($out | Out-String).Trim()
}

Check "Pi 服务状态" {
  $out = Invoke-PiSsh "systemctl is-active antifieldcloud cloudflared opencode minecraft | tr '\n' ' '"
  $text = ($out | Out-String).Trim()
  if ($text -notmatch "active active active active") { throw $text }
  $text
}

Check "Pi systemctl --failed 为空" {
  $out = Invoke-PiSsh "systemctl --failed --no-legend --no-pager | wc -l"
  $count = [int](($out | Out-String).Trim())
  if ($count -ne 0) {
    $detail = (Invoke-PiSsh "systemctl --failed --no-legend --no-pager" | Out-String).Trim()
    throw "存在 $count 个失败单元：$detail"
  }
  "0 failed"
}

Check "Pi 本机应用健康" {
  $out = Invoke-PiSsh "curl -fsS --max-time 5 http://127.0.0.1:3000/healthz"
  ($out | Out-String).Trim()
}

if ($ExpectedVersion) {
  Check "应用版本与预期一致（$ExpectedVersion）" {
    $raw = (Invoke-PiSsh "curl -fsS --max-time 5 http://127.0.0.1:3000/healthz" | Out-String)
    $health = ConvertFrom-JsonText $raw
    if (-not $health) { throw "无法解析 /healthz：$raw" }
    if ([string]$health.version -ne $ExpectedVersion) {
      throw "version=$($health.version)，期望 $ExpectedVersion（检查 /etc/antifieldcloud/env 的 APP_VERSION 并重启）"
    }
    "version=$($health.version)"
  }
}

if ($ExpectedSchemaVersion -gt 0) {
  Check "数据库 schema 版本与预期一致（$ExpectedSchemaVersion）" {
    $raw = (Invoke-PiSsh "curl -fsS --max-time 5 http://127.0.0.1:3000/healthz" | Out-String)
    $health = ConvertFrom-JsonText $raw
    if (-not $health) { throw "无法解析 /healthz：$raw" }
    if ([int]$health.schemaVersion -ne $ExpectedSchemaVersion) {
      throw "schemaVersion=$($health.schemaVersion)，期望 $ExpectedSchemaVersion（迁移失败或回滚未还原 DB）"
    }
    "schemaVersion=$($health.schemaVersion)"
  }
}

Check "内存 cgroup 控制器可用" {
  $out = Invoke-PiSsh "cat /sys/fs/cgroup/cgroup.controllers"
  $text = ($out | Out-String).Trim()
  if ($text -notmatch '(^|\s)memory(\s|$)') {
    throw "memory 控制器未启用（检查内核 cmdline 的 cgroup_disable=memory 并重启）"
  }
  $text
}

Check "nftables 规则生效" {
  $out = Invoke-PiSsh "sudo /usr/sbin/nft list ruleset | grep -c '25575'"
  if (-not ($out | Out-String).Trim()) { throw "nft 查询失败" }
  "包含 25575 规则"
}

Check "外部 RCON 25575 已阻断" {
  $open = (Test-NetConnection -ComputerName $PiHost -Port 25575 -InformationLevel Quiet -WarningAction SilentlyContinue)
  if ($open) { throw "25575 仍可外部访问" }
  "已阻断"
}

Check "Minecraft 25565 可达（直连）" {
  $open = (Test-NetConnection -ComputerName $PiHost -Port 25565 -InformationLevel Quiet -WarningAction SilentlyContinue)
  if (-not $open) { throw "25565 不可达（若改了防火墙规则请检查）" }
  "可达"
}

Check "备份 CLI pending 可用" {
  $out = Invoke-PiSsh "sudo -u antifieldcloud -H /usr/local/bin/node /opt/antifieldcloud/current/scripts/backup.mjs --pending --no-warnings"
  $json = ConvertFrom-JsonText ($out | Out-String)
  if (-not $json -or -not $json.ok) { throw "pending 查询失败：$($out | Out-String)" }
  foreach ($item in @($json.pending)) {
    if ($item.exists -eq $false) { throw "pending 归档文件缺失：$($item.name)" }
  }
  "pending=$($json.count) needsFull=$($json.needsFull)"
}

Check "备份拉取状态（含密钥包状态）" {
  $json = Get-PiJsonFile "/var/lib/antifieldcloud/backup-pull.json"
  if (-not $json -or -not $json.lastPullAt) { throw "尚未完成首次拉取或状态 JSON 无效" }
  $ageHours = Get-StampAgeHours $json.lastPullAt
  if ($null -eq $ageHours) { throw "lastPullAt 无法解析：$($json.lastPullAt)" }
  if ($ageHours -gt 48) { throw "最近拉取已超过 48 小时（$([math]::Round($ageHours,1)) h）" }
  if ($json.secretsAttempted -eq $true -and $json.secretsOk -ne $true) {
    throw "密钥包拉取失败：$($json.secretsLastError)（secretsOk=$($json.secretsOk)）"
  }
  "lastPullAt=$($json.lastPullAt) age=$([math]::Round($ageHours,1))h secretsOk=$($json.secretsOk)"
}

# 世界备份/拉取/演练状态：文件缺失视为未启用（WARN），存在但 ok=false 或超期视为 FAIL。
Check "世界备份状态" {
  $json = Get-PiJsonFile "/var/lib/antifieldcloud/world-backup-status.json"
  if (-not $json) {
    Warn "世界备份状态" "尚未生成 world-backup-status.json（antifieldcloud-world.timer 可能未安装）"
    return "未启用"
  }
  if ($json.ok -ne $true) { throw "最近一次世界备份失败：$($json.error) $($json.message)" }
  $ageHours = Get-StampAgeHours $json.lastRunAt
  if ($null -ne $ageHours -and $ageHours -gt 192) { throw "世界备份已超过 8 天（$([math]::Round($ageHours,1)) h）" }
  "archive=$($json.archiveName) age=$(if ($null -ne $ageHours) { [math]::Round($ageHours,1) } else { '?' })h"
}

Check "世界备份拉取状态" {
  $json = Get-PiJsonFile "/var/lib/antifieldcloud/world-pull-status.json"
  if (-not $json) {
    Warn "世界备份拉取状态" "尚未生成 world-pull-status.json（Windows 世界拉取任务可能未安装）"
    return "未启用"
  }
  if ($json.ok -ne $true) { throw "最近一次世界拉取失败：$($json.error) $($json.message)" }
  $ageHours = Get-StampAgeHours $json.lastPullAt
  if ($null -ne $ageHours -and $ageHours -gt 192) { throw "世界备份拉取已超过 8 天（$([math]::Round($ageHours,1)) h）" }
  "pulled=$($json.pulledCount) age=$(if ($null -ne $ageHours) { [math]::Round($ageHours,1) } else { '?' })h"
}

Check "恢复演练状态" {
  $json = Get-PiJsonFile "/var/lib/antifieldcloud/drill-status.json"
  if (-not $json) {
    Warn "恢复演练状态" "尚未生成 drill-status.json（可能是本机从未回写演练状态）"
    return "未启用"
  }
  if ($json.ok -ne $true) { throw "最近一次恢复演练失败：$($json.error) $($json.message)" }
  $ageDays = Get-StampAgeHours $json.lastRunAt
  if ($null -ne $ageDays -and ($ageDays / 24) -gt 35) { throw "恢复演练已超过 35 天（$([math]::Round($ageDays / 24,1)) 天）" }
  "report=$($json.report) age=$(if ($null -ne $ageDays) { [math]::Round($ageDays / 24,1) } else { '?' })d"
}

if (-not $SkipScriptHash) {
  Check "Pi 已安装脚本与仓库一致" {
    $files = @(
      "scripts/backup-world.mjs",
      "scripts/backup-secrets.sh",
      "scripts/bootstrap-env.sh"
    )
    foreach ($relative in $files) {
      $localPath = Join-Path $root $relative
      if (-not (Test-Path -LiteralPath $localPath)) { throw "本地缺少 $relative（在仓库根目录运行 smoke）" }
      $localSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $localPath).Hash.ToLower()
      $remoteSha = (Invoke-PiSsh "sha256sum /opt/antifieldcloud/current/$relative 2>/dev/null | cut -d' ' -f1" -TimeoutSeconds 30 | Out-String).Trim().ToLower()
      if ($remoteSha -ne $localSha) { throw "$relative 不一致（远端 $remoteSha / 本地 $localSha）" }
    }
    "3 个脚本 SHA-256 一致"
  }
}

if (-not $SkipLocalBackup) {
  Check "本地备份 .sha256 旁文件" {
    if (-not (Test-Path $BackupRoot)) { throw "备份目录不存在：$BackupRoot" }
    $latest = Get-ChildItem $BackupRoot -Recurse -Filter *.tar.gz -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $latest) { throw "未找到本地归档：$BackupRoot" }
    if (-not (Test-Path "$($latest.FullName).sha256")) { throw "缺少 sha256 旁文件：$($latest.Name)" }
    "OK $($latest.Name)"
  }
}

Write-Host ""
Write-Host ("结果：{0} 通过，{1} 失败，{2} 警告" -f $script:pass, $script:fail, $script:warn)
if ($script:fail -gt 0) { exit 1 }

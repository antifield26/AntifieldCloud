param(
  [string]$PiHost = "192.0.2.10",
  [string]$PiUser = "antifield",
  [string]$AppUrl = "https://app.example.com",
  [string]$AiUrl = "https://ai.example.com",
  [string]$BackupRoot = (Join-Path $env:USERPROFILE "AntifieldCloudBackups"),
  [switch]$SkipPublic,
  [switch]$SkipLocalBackup,
  [switch]$SkipLocalTaskCheck,
  [switch]$SkipScriptHash,
  [switch]$SkipOpenCode,
  [switch]$SkipMcp,
  [switch]$SkipFail2ban,
  [switch]$SkipUnitDrift,
  [switch]$SkipEnvDrift,
  [switch]$SkipEncryption,
  [switch]$SkipOffsite,
  [string]$ExpectedVersion = "",
  [int]$ExpectedSchemaVersion = 0,
  [string]$ExpectedOpenCodeVersion = "",
  [string[]]$ExpectedSshSources = @(),
  [int]$MaxMcpProcesses = 12,
  [string]$AccessClientId = "",
  [string]$AccessClientSecret = ""
)

# 部署后冒烟（只读）：公网 HTTPS、PWA/分享/告警端点、Pi 本机服务/版本、OpenCode 版本/MCP、
# 内存 cgroup、nftables（含可选 SSH 来源断言）、fail2ban、systemd unit 漂移、env 键漂移、
# 备份 pending/拉取状态/密钥包状态/加密状态、世界备份与世界拉取状态、演练状态、异地副本状态、
# 已安装脚本 SHA-256 与本地仓库一致性、本地备份旁文件内容、Windows 任务安装标记；
# 本地检查可 -SkipLocalBackup / -SkipLocalTaskCheck 跳过，外部可选检查有 -Skip* 开关。
# 所有 SSH 命令带重试与硬超时（Start-Process + taskkill /T /F）；只读，不修改 Pi 状态。
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$target = "$PiUser@$PiHost"
$script:pass = 0
$script:fail = 0
$script:warn = 0
$script:skip = 0
$root = Split-Path -Parent $PSScriptRoot

function Check {
  param([string]$Name, [scriptblock]$Action)
  try {
    $result = & $Action
    $text = if ($null -eq $result) { "" } else { [string]$result }
    if ($text -like "SKIP:*") {
      Write-Host ("SKIP  {0}  {1}" -f $Name, $text.Substring(5).Trim()) -ForegroundColor DarkGray
      $script:skip++
      return
    }
    if ($result -eq $false) { throw "返回值 false" }
    Write-Host ("PASS  {0}  {1}" -f $Name, $text) -ForegroundColor Green
    $script:pass++
  } catch {
    Write-Host ("FAIL  {0}  {1}" -f $Name, $_.Exception.Message) -ForegroundColor Red
    $script:fail++
  }
}

# 非阻断检查：失败只记 WARN（用于“可选依赖/可能尚未安装”的项，如 MCP 进程数、env 漂移）。
function SoftCheck {
  param([string]$Name, [scriptblock]$Action)
  try {
    $result = & $Action
    $text = if ($null -eq $result) { "" } else { [string]$result }
    Write-Host ("PASS  {0}  {1}" -f $Name, $text) -ForegroundColor Green
    $script:pass++
  } catch {
    Write-Host ("WARN  {0}  {1}" -f $Name, $_.Exception.Message) -ForegroundColor Yellow
    $script:warn++
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

# 读取 Pi 上 /etc/antifieldcloud/env 的单个键（只读；值不用于日志，避免泄露密钥）。
function Get-PiEnvValue {
  param([string]$Key)
  $out = Invoke-PiSsh "sudo grep -E '^$Key=' /etc/antifieldcloud/env 2>/dev/null | tail -n 1 | cut -d= -f2-" -TimeoutSeconds 30
  return ($out | Out-String).Trim()
}

# 读取 Pi 上 env 的键名列表（不含值）。
function Get-PiEnvKeys {
  $out = Invoke-PiSsh "sudo grep -E '^[A-Za-z_][A-Za-z0-9_]*=' /etc/antifieldcloud/env 2>/dev/null | cut -d= -f1 | sort -u" -TimeoutSeconds 30
  return @(($out | Out-String) -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })
}

# 读取仓库 bootstrap-env.sh 的 MANAGED_KEYS（本地静态解析；用于 env 漂移检查）。
function Get-ManagedEnvKeys {
  $path = Join-Path $root "scripts/bootstrap-env.sh"
  if (-not (Test-Path -LiteralPath $path)) { throw "本地缺少 scripts/bootstrap-env.sh（请在仓库根运行）" }
  $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
  $match = [regex]::Match($text, 'MANAGED_KEYS=\(\n([\s\S]*?)\n\)')
  if (-not $match.Success) { throw "无法解析 bootstrap-env.sh 的 MANAGED_KEYS" }
  $keys = @()
  foreach ($token in ($match.Groups[1].Value -split "\s+")) {
    if ($token -match '^[A-Z][A-Z0-9_]+$') { $keys += $token }
  }
  return $keys
}


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

# v0.7.0 /healthz 新增字段：db=ok（DB 可读）与 pendingBackups（待 ack 数量）。
Check "healthz db/pendingBackups 字段" {
  $raw = (Invoke-PiSsh "curl -fsS --max-time 5 http://127.0.0.1:3000/healthz" | Out-String)
  $health = ConvertFrom-JsonText $raw
  if (-not $health) { throw "无法解析 /healthz：$raw" }
  if ($health.ok -ne $true) { throw "ok=$($health.ok)" }
  if ([string]$health.db -ne "ok") { throw "db=$($health.db)（期望 ok；DB 可读性异常）" }
  if ($null -eq $health.pendingBackups) { throw "缺少 pendingBackups 字段（服务端未升级到 v0.7.0？）" }
  "db=ok pendingBackups=$($health.pendingBackups)"
}

# OpenCode 版本（v2.1.4 升级门禁；可 -SkipOpenCode）：路径固定为生产安装位置。
if (-not $SkipOpenCode -and $ExpectedOpenCodeVersion) {
  Check "OpenCode 版本与预期一致（$ExpectedOpenCodeVersion）" {
    $out = (Invoke-PiSsh "sudo -u opencode env HOME=/var/lib/opencode /var/lib/opencode/.opencode/bin/opencode --version 2>&1" -TimeoutSeconds 30 | Out-String).Trim()
    $match = [regex]::Match($out, 'v?(\d+\.\d+\.\d+)')
    if (-not $match.Success) { throw "无法解析 opencode --version：$out" }
    $actual = $match.Groups[1].Value
    if ($actual -ne $ExpectedOpenCodeVersion) { throw "opencode=$actual，期望 $ExpectedOpenCodeVersion（升级/回滚未完成？）" }
    "v$actual"
  }
}

# MCP 服务状态（v2.1.4 lifecycle 升级重点；可 -SkipMcp）：只读 /api/mcp，密码只在远端 shell 变量中使用。
if (-not $SkipMcp) {
  Check "OpenCode MCP 服务状态" {
    $command = @'
sudo sh -c 'P=$(grep -E "^OPENCODE_PASSWORD=" /etc/opencode/opencode.env | head -n1 | cut -d= -f2-); AUTH=$(printf "%s" "opencode:$P" | base64 -w0); curl -fsS --max-time 5 -H "Authorization: Basic $AUTH" http://127.0.0.1:4096/api/mcp' 2>&1
'@
    # MCP 在 2.1.4 为懒加载：重启/升级后可能数秒才 connected，最多重试 6 次（约 12s）。
    $out = ""
    for ($attempt = 0; $attempt -lt 6; $attempt++) {
      $out = (Invoke-PiSsh $command.Trim() -TimeoutSeconds 30 | Out-String).Trim()
      if ($out -match 'botmsg' -and $out -match 'searxng' -and $out -match 'connected|ready') { break }
      Start-Sleep -Seconds 2
    }
    if ($out -notmatch 'botmsg') { throw "MCP 输出中未发现 botmsg（重试后）：$(($out -split "`n")[0])" }
    if ($out -notmatch 'searxng') { throw "MCP 输出中未发现 searxng（重试后）：$(($out -split "`n")[0])" }
    if ($out -notmatch 'connected|ready') { throw "MCP 服务未显示 connected/ready（重试后）：$(($out -split "`n")[0])" }
    "botmsg+searxng 已连接"
  }
  SoftCheck "MCP 进程数量（<= $MaxMcpProcesses）" {
    $countText = (Invoke-PiSsh "pgrep -fc 'bot-tool-mcp.mjs|searxng-mcp.mjs' 2>/dev/null || echo 0" -TimeoutSeconds 30 | Out-String).Trim()
    $count = [int]$countText
    if ($count -gt $MaxMcpProcesses) { throw "MCP 进程数 $count 超过阈值 $MaxMcpProcesses（可能重复 spawn/残留）" }
    "count=$count"
  }
}

# fail2ban（可 -SkipFail2ban）：未安装时 SKIP；已安装则必须 active + sshd jail + 24h 封禁。
if (-not $SkipFail2ban) {
  Check "fail2ban sshd jail" {
    $installed = (Invoke-PiSsh "systemctl cat fail2ban.service >/dev/null 2>&1 && echo YES || echo NO" -TimeoutSeconds 30 | Out-String).Trim()
    if ($installed -ne "YES") { return "SKIP: fail2ban 未安装" }
    $active = (Invoke-PiSsh "systemctl is-active fail2ban" -TimeoutSeconds 30 | Out-String).Trim()
    if ($active -ne "active") { throw "fail2ban 状态=$active" }
    $status = (Invoke-PiSsh "sudo fail2ban-client status sshd 2>&1" -TimeoutSeconds 30 | Out-String)
    if ($status -notmatch 'Currently banned') { throw "sshd jail 不可用：$(($status -split "`n")[0])" }
    $bantimeText = (Invoke-PiSsh "sudo fail2ban-client get sshd bantime 2>/dev/null" -TimeoutSeconds 30 | Out-String).Trim()
    $bantime = 0
    if ([int]::TryParse($bantimeText, [ref]$bantime) -and $bantime -ne 86400) {
      throw "sshd bantime=$bantime，期望 86400（24h）"
    }
    "active，bantime=${bantime}s"
  }
}

# systemd unit 漂移（可 -SkipUnitDrift）：安装文件必须与仓库模板一致，避免“代码升级但 unit 没更新”。
if (-not $SkipUnitDrift) {
  Check "systemd unit 与仓库一致" {
    $pairs = @(
      @{ Local = "deploy/antifieldcloud.service"; Remote = "/etc/systemd/system/antifieldcloud.service" },
      @{ Local = "deploy/antifieldcloud-world.service"; Remote = "/etc/systemd/system/antifieldcloud-world.service" },
      @{ Local = "deploy/antifieldcloud-world.timer"; Remote = "/etc/systemd/system/antifieldcloud-world.timer" },
      @{ Local = "deploy/antifieldcloud-health.service"; Remote = "/etc/systemd/system/antifieldcloud-health.service" },
      @{ Local = "deploy/antifieldcloud-health.timer"; Remote = "/etc/systemd/system/antifieldcloud-health.timer" },
      @{ Local = "deploy/systemd/searxng.service"; Remote = "/etc/systemd/system/searxng.service" },
      @{ Local = "deploy/systemd/nftables.service.d/10-fail2ban-restore.conf"; Remote = "/etc/systemd/system/nftables.service.d/10-fail2ban-restore.conf" }
    )
    $missing = @()
    $mismatch = @()
    foreach ($pair in $pairs) {
      $localPath = Join-Path $root $pair.Local
      if (-not (Test-Path -LiteralPath $localPath)) { throw "本地缺少 $($pair.Local)" }
      $localSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $localPath).Hash.ToLower()
      $remoteSha = (Invoke-PiSsh "sudo sha256sum '$($pair.Remote)' 2>/dev/null | cut -d' ' -f1" -TimeoutSeconds 30 | Out-String).Trim().ToLower()
      if ($remoteSha -eq "") { $missing += $pair.Remote; continue }
      if ($remoteSha -ne $localSha) { $mismatch += "$($pair.Remote)（远端 $remoteSha / 本地 $localSha）" }
    }
    if ($mismatch.Count -gt 0) { throw ("unit 内容不一致：" + ($mismatch -join '；')) }
    if ($missing.Count -gt 0) { return "SKIP: 未安装（$($missing.Count) 个）：$($missing -join ', ')" }
    "$($pairs.Count) 个 unit 一致"
  }
}

# env 键漂移（可 -SkipEnvDrift）：只 WARN；用于发现 v0.5.x 已删除键仍残留（OPS-04 清理依据）。
if (-not $SkipEnvDrift) {
  SoftCheck "env 键漂移（相对 bootstrap MANAGED_KEYS）" {
    $managed = Get-ManagedEnvKeys
    $knownExtra = @("MC_PROPERTIES", "OPENCODE_ENV", "TZ", "APP_VERSION")
    $remoteKeys = Get-PiEnvKeys
    $unknown = @($remoteKeys | Where-Object { $managed -notcontains $_ -and $knownExtra -notcontains $_ })
    if ($unknown.Count -gt 0) {
      $sample = ($unknown | Select-Object -First 12) -join ', '
      throw "env 有 $($unknown.Count) 个非纳管键（可用 bootstrap-env.sh --force --prune-unknown 清理，先备份）：$sample"
    }
    "0 个非纳管键"
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
  $ruleset = (Invoke-PiSsh "sudo /usr/sbin/nft list ruleset" | Out-String)
  if ($ruleset -notmatch '25575') { throw "nft 规则中未见 25575 相关规则" }
  foreach ($source in @($ExpectedSshSources)) {
    if ($source -and $ruleset -notmatch [regex]::Escape($source)) {
      throw "nftables 规则中未找到期望 SSH 来源：$source（检查 deploy/nftables.conf 是否已按实际网段安装）"
    }
  }
  if (@($ExpectedSshSources).Count -gt 0) { "包含 25575 与 $($ExpectedSshSources.Count) 个期望 SSH 来源" } else { "包含 25575 规则" }
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

# 世界备份/拉取/演练状态：文件缺失视为未启用（SKIP，不计 PASS），存在但 ok=false 或超期视为 FAIL。
Check "世界备份状态" {
  $json = Get-PiJsonFile "/var/lib/antifieldcloud/world-backup-status.json"
  if (-not $json) {
    return "SKIP: 尚未生成 world-backup-status.json（antifieldcloud-world.timer 可能未安装）"
  }
  if ($json.ok -ne $true) { throw "最近一次世界备份失败：$($json.error) $($json.message)" }
  $ageHours = Get-StampAgeHours $json.lastRunAt
  if ($null -ne $ageHours -and $ageHours -gt 192) { throw "世界备份已超过 8 天（$([math]::Round($ageHours,1)) h）" }
  "archive=$($json.archiveName) age=$(if ($null -ne $ageHours) { [math]::Round($ageHours,1) } else { '?' })h"
}

Check "世界备份拉取状态" {
  $json = Get-PiJsonFile "/var/lib/antifieldcloud/world-pull-status.json"
  if (-not $json) {
    return "SKIP: 尚未生成 world-pull-status.json（Windows 世界拉取任务可能未安装）"
  }
  if ($json.ok -ne $true) { throw "最近一次世界拉取失败：$($json.error) $($json.message)" }
  $ageHours = Get-StampAgeHours $json.lastPullAt
  if ($null -ne $ageHours -and $ageHours -gt 192) { throw "世界备份拉取已超过 8 天（$([math]::Round($ageHours,1)) h）" }
  "pulled=$($json.pulledCount) age=$(if ($null -ne $ageHours) { [math]::Round($ageHours,1) } else { '?' })h"
}

Check "恢复演练状态" {
  $json = Get-PiJsonFile "/var/lib/antifieldcloud/drill-status.json"
  if (-not $json) {
    return "SKIP: 尚未生成 drill-status.json（可能是本机从未回写演练状态）"
  }
  if ($json.ok -ne $true) { throw "最近一次恢复演练失败：$($json.error) $($json.message)" }
  $ageDays = Get-StampAgeHours $json.lastRunAt
  if ($null -ne $ageDays -and ($ageDays / 24) -gt 35) { throw "恢复演练已超过 35 天（$([math]::Round($ageDays / 24,1)) 天）" }
  # 演练必须针对当前 schema；旧 schema 的演练成功不能代表当前库可恢复，只告警不阻断部署。
  if ($ExpectedSchemaVersion -gt 0 -and $null -ne $json.schemaVersion) {
    $drillSchema = [int]$json.schemaVersion
    if ($drillSchema -ne $ExpectedSchemaVersion) {
      Warn "恢复演练状态" "演练 schemaVersion=$drillSchema 与当前 schema $ExpectedSchemaVersion 不一致；请用 drill.ps1 -ExpectedSchemaVersion $ExpectedSchemaVersion 重跑"
    }
  }
  "report=$($json.report) schema=$(if ($null -ne $json.schemaVersion) { $json.schemaVersion } else { '?' }) age=$(if ($null -ne $ageDays) { [math]::Round($ageDays / 24,1) } else { '?' })d"
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
    "$($files.Count) 个脚本 SHA-256 一致"
  }
  # 安装在 release 之外的自研 MCP/健康探针：不一致说明“仓库更新但未重跑安装脚本”。
  SoftCheck "Pi 已安装 MCP/探针脚本一致" {
    $pairs = @(
      @{ Local = "scripts/bot-tool-mcp.mjs"; Remote = "/opt/botmsg-mcp/bot-tool-mcp.mjs" },
      @{ Local = "scripts/searxng-mcp.mjs"; Remote = "/opt/searxng-mcp/searxng-mcp.mjs" },
      @{ Local = "deploy/health-probe.sh"; Remote = "/usr/local/libexec/antifieldcloud-health.sh" }
    )
    $missing = @()
    $mismatch = @()
    foreach ($pair in $pairs) {
      $localPath = Join-Path $root $pair.Local
      if (-not (Test-Path -LiteralPath $localPath)) { continue }
      $localSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $localPath).Hash.ToLower()
      $remoteSha = (Invoke-PiSsh "sudo sha256sum '$($pair.Remote)' 2>/dev/null | cut -d' ' -f1" -TimeoutSeconds 30 | Out-String).Trim().ToLower()
      if ($remoteSha -eq "") { $missing += $pair.Remote; continue }
      if ($remoteSha -ne $localSha) { $mismatch += "$($pair.Remote)（远端 $remoteSha / 本地 $localSha）" }
    }
    if ($mismatch.Count -gt 0) { throw ("不一致：" + ($mismatch -join '；')) }
    if ($missing.Count -gt 0) { throw ("未安装：" + ($missing -join ', ')) }
    "$($pairs.Count) 个脚本一致"
  }
}

# 备份加密状态（v0.7.0）：开关开启时校验公钥/age/临时明文；关闭时 SKIP。
if (-not $SkipEncryption) {
  Check "备份加密配置" {
    $enabled = Get-PiEnvValue "BACKUP_ARCHIVE_ENCRYPTION"
    if ($enabled -ne "true") { return "SKIP: BACKUP_ARCHIVE_ENCRYPTION=$enabled（默认关闭）" }
    $recipientFile = Get-PiEnvValue "BACKUP_AGE_RECIPIENT_FILE"
    if ([string]::IsNullOrWhiteSpace($recipientFile)) { $recipientFile = "/etc/antifieldcloud/backup-age.pub" }
    $stat = (Invoke-PiSsh "sudo stat -c '%a %u %g' '$recipientFile' 2>/dev/null || echo MISSING" -TimeoutSeconds 30 | Out-String).Trim()
    if ($stat -eq "MISSING") { throw "缺少 age 公钥文件：$recipientFile" }
    $fields = $stat -split '\s+'
    if ($fields.Count -ge 3) {
      $mode = [Convert]::ToInt32($fields[0], 8)
      if (($mode -band 0x12) -ne 0) { throw "age 公钥权限过宽（$($fields[0])，要求组/其他不可写）" }
      if ($fields[1] -ne "0") { throw "age 公钥必须 root 所有（owner=$($fields[1])）" }
    }
    $recipient = (Invoke-PiSsh "sudo head -n 1 '$recipientFile'" -TimeoutSeconds 30 | Out-String).Trim()
    if ($recipient -notmatch '^age1[0-9a-z]{16,}$') { throw "age 公钥格式非法" }
    $ageVersion = (Invoke-PiSsh "age --version 2>/dev/null || echo MISSING" -TimeoutSeconds 30 | Out-String).Trim()
    if ($ageVersion -eq "MISSING") { throw "Pi 上未安装 age" }
    $plainTmp = (Invoke-PiSsh "sudo find /var/lib/antifieldcloud/backups -maxdepth 1 -name '*.plain.tmp' -mmin +1440 2>/dev/null | wc -l" -TimeoutSeconds 30 | Out-String).Trim()
    if ([int]$plainTmp -gt 0) { throw "存在超过 24h 的明文临时归档残留（$plainTmp 个），需人工检查" }
    "enabled，公钥/age/临时明文检查通过（age=$ageVersion）"
  }
}

# 异地副本状态（v0.7.0）：状态文件缺失视为未启用 SKIP；存在则校验 ok/超期/明文漏传。
if (-not $SkipOffsite) {
  Check "异地副本状态" {
    $statusFile = Get-PiEnvValue "BACKUP_OFFSITE_STATUS_FILE"
    if ([string]::IsNullOrWhiteSpace($statusFile)) { $statusFile = "/var/lib/antifieldcloud/backup-offsite-status.json" }
    $json = Get-PiJsonFile $statusFile
    if (-not $json) { return "SKIP: 未配置/未运行异地副本（$statusFile 不存在）" }
    if ($json.ok -ne $true) { throw "最近一次异地副本失败：$($json.error)" }
    $thresholdText = Get-PiEnvValue "ALERT_OFFSITE_MAX_AGE_HOURS"
    $threshold = 48
    if (-not [int]::TryParse($thresholdText, [ref]$threshold) -or $threshold -le 0) { $threshold = 48 }
    $ageHours = Get-StampAgeHours $json.lastRunAt
    if ($null -eq $ageHours) { throw "lastRunAt 无法解析：$($json.lastRunAt)" }
    if ($ageHours -gt $threshold) { throw "异地副本已超过 $threshold 小时未成功（$([math]::Round($ageHours,1)) h）" }
    if ([int]$json.plaintextSkipped -gt 0) { throw "检测到明文归档被跳过（plaintextSkipped=$($json.plaintextSkipped)），请检查是否误把明文放入备份根" }
    "ok，age=$([math]::Round($ageHours,1))h，uploaded=$($json.uploaded) keptRemote=$($json.keptRemote)"
  }
}

# Windows 任务安装标记（本地，可 -SkipLocalTaskCheck）：版本/脚本 SHA 必须与仓库一致。
if (-not $SkipLocalTaskCheck) {
  Check "Windows 备份任务安装标记" {
    $markerPath = Join-Path $env:LOCALAPPDATA "AntifieldCloud\backup-task.json"
    if (-not (Test-Path -LiteralPath $markerPath)) { throw "缺少安装标记：$markerPath（请运行 install-backup-task.ps1）" }
    $marker = ([System.IO.File]::ReadAllText($markerPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json)
    $packageVersion = [string](([System.IO.File]::ReadAllText((Join-Path $root "package.json"), [System.Text.Encoding]::UTF8) | ConvertFrom-Json).version)
    if ([string]$marker.appVersion -ne $packageVersion) {
      throw "安装标记 appVersion=$($marker.appVersion)，仓库=$packageVersion（请重装计划任务）"
    }
    $localScript = Join-Path $PSScriptRoot "backup-pull.ps1"
    if (Test-Path -LiteralPath $localScript) {
      $localSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $localScript).Hash.ToLower()
      if ([string]$marker.scriptSha256 -ne $localSha) { throw "安装标记 scriptSha256 与仓库 backup-pull.ps1 不一致（请重装计划任务）" }
    }
    "version=$($marker.appVersion) scriptSha256 一致"
  }
}

if (-not $SkipLocalBackup) {
  Check "本地备份旁文件内容校验" {
    if (-not (Test-Path $BackupRoot)) { throw "备份目录不存在：$BackupRoot" }
    $latest = Get-ChildItem $BackupRoot -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '\.tar\.gz(\.age)?$' } |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $latest) { throw "未找到本地归档：$BackupRoot" }
    $sidecarPath = "$($latest.FullName).sha256"
    if (-not (Test-Path $sidecarPath)) { throw "缺少 sha256 旁文件：$($latest.Name)" }
    $sidecar = [System.IO.File]::ReadAllText($sidecarPath, [System.Text.Encoding]::UTF8)
    $match = [regex]::Match($sidecar, '^([0-9a-fA-F]{64})\s+')
    if (-not $match.Success) { throw "sha256 旁文件格式异常：$($latest.Name)" }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $latest.FullName).Hash.ToLower()
    if ($match.Groups[1].Value.ToLower() -ne $actual) { throw "旁文件 SHA 与归档内容不一致：$($latest.Name)" }
    if ($latest.Name -match '\.age$') {
      if (-not (Test-Path "$($latest.FullName).meta.json")) { throw "加密归档缺少 .meta.json：$($latest.Name)" }
    }
    "OK $($latest.Name)（SHA 一致，encrypted=$($latest.Name -match '\.age$')）"
  }
}

Write-Host ""
Write-Host ("结果：{0} 通过，{1} 失败，{2} 警告，{3} 跳过" -f $script:pass, $script:fail, $script:warn, $script:skip)
if ($script:fail -gt 0) { exit 1 }

param(
  [string]$PiHost = "192.0.2.10",
  [string]$PiUser = "antifield",
  [string]$AppUrl = "https://app.example.com",
  [string]$AiUrl = "https://ai.example.com",
  [string]$BackupRoot = (Join-Path $env:USERPROFILE "AntifieldCloudBackups"),
  [switch]$SkipPublic
)

# 部署后冒烟（只读）：公网 HTTPS、PWA/分享/告警端点、Pi 本机服务、内存 cgroup、nftables、
# 备份 pending/状态与本地 .sha256 旁文件。SSH 检查带重试，避免直连网线丢包导致误报。
$ErrorActionPreference = "Continue"
$target = "$PiUser@$PiHost"
$pass = 0
$fail = 0
$warn = 0

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

# SSH 检查统一重试 3 次；只读命令，不修改 Pi 状态。
function Invoke-PiSsh {
  param([string]$Command, [int]$Attempts = 3)
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    $out = & ssh.exe -o BatchMode=yes -o ConnectTimeout=10 $target $Command 2>&1
    if ($LASTEXITCODE -eq 0) { return $out }
    if ($attempt -eq $Attempts) { throw "ssh exit=$LASTEXITCODE：$out" }
    Start-Sleep -Seconds 5
  }
}

function Get-HttpStatus {
  param([string]$Url)
  return (& curl.exe -sS -o NUL -w "%{http_code}" --max-time 20 $Url 2>&1 | Out-String).Trim()
}

function Get-HttpHeaders {
  param([string]$Url)
  return (& curl.exe -sS -D - -o NUL --max-time 20 $Url 2>&1 | Out-String)
}

function ConvertFrom-JsonText {
  param([string]$Text)
  $line = ($Text -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\{' } | Select-Object -Last 1)
  if (-not $line) { return $null }
  try { return ($line | ConvertFrom-Json) } catch { return $null }
}

if (-not $SkipPublic) {
  Check "公网 app 健康检查" {
    $code = Get-HttpStatus "$AppUrl/healthz"
    if ($code -ne "200") { throw "HTTP $code" }
    "HTTP 200"
  }
  Check "公网 ai 登录跳转/401" {
    $code = Get-HttpStatus "$AiUrl/"
    if ($code -ne "302" -and $code -ne "401") { throw "HTTP $code" }
    "HTTP $code"
  }
  Check "公网安全响应头" {
    $headers = Get-HttpHeaders "$AppUrl/"
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
      $code = Get-HttpStatus "$AppUrl$path"
      if ($code -ne "200") { throw "$path HTTP $code" }
    }
    "manifest+sw+offline 200"
  }
  Check "公开分享页 404/410" {
    $code = Get-HttpStatus "$AppUrl/s/antifieldcloud-smoke-invalid-token"
    if ($code -ne "404" -and $code -ne "410") { throw "HTTP $code（预期 404/410）" }
    "HTTP $code"
  }
  Check "告警 API 未登录 401" {
    $code = Get-HttpStatus "$AppUrl/api/alerts"
    if ($code -ne "401") { throw "HTTP $code" }
    "HTTP 401"
  }
}

Check "Pi SSH 可达" {
  $out = Invoke-PiSsh "echo ok"
  ($out | Out-String).Trim()
}

Check "Pi 服务状态" {
  $out = Invoke-PiSsh "systemctl is-active antifieldcloud cloudflared opencode minecraft | tr '\n' ' '"
  $text = ($out | Out-String).Trim()
  if ($text -notmatch "active active active active") { throw $text }
  $text
}

Check "Pi 本机应用健康" {
  $out = Invoke-PiSsh "curl -fsS --max-time 5 http://127.0.0.1:3000/healthz"
  ($out | Out-String).Trim()
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
  $out = Invoke-PiSsh "sudo -u antifieldcloud -H /usr/local/bin/node /opt/antifieldcloud/current/scripts/backup.mjs --pending"
  $json = ConvertFrom-JsonText ($out | Out-String)
  if (-not $json -or -not $json.ok) { throw "pending 查询失败：$($out | Out-String)" }
  foreach ($item in @($json.pending)) {
    if ($item.exists -eq $false) { throw "pending 归档文件缺失：$($item.name)" }
  }
  "pending=$($json.count) needsFull=$($json.needsFull)"
}

Check "备份拉取状态" {
  $out = Invoke-PiSsh "cat /var/lib/antifieldcloud/backup-pull.json 2>/dev/null || echo NONE"
  $text = ($out | Out-String).Trim()
  if ($text -eq "NONE" -or $text -eq "") { throw "尚未完成首次拉取" }
  $json = ConvertFrom-JsonText $text
  if (-not $json -or -not $json.lastPullAt) { throw "状态 JSON 无效：$text" }
  $ageHours = ((Get-Date).ToUniversalTime() - [datetime]::Parse($json.lastPullAt).ToUniversalTime()).TotalHours
  if ($ageHours -gt 48) { throw "最近拉取已超过 48 小时（$([math]::Round($ageHours,1)) h）" }
  "lastPullAt=$($json.lastPullAt) age=$([math]::Round($ageHours,1))h"
}

Check "本地备份 .sha256 旁文件" {
  if (-not (Test-Path $BackupRoot)) { throw "备份目录不存在：$BackupRoot" }
  $latest = Get-ChildItem $BackupRoot -Recurse -Filter *.tar.gz -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $latest) { throw "未找到本地归档：$BackupRoot" }
  if (-not (Test-Path "$($latest.FullName).sha256")) { throw "缺少 sha256 旁文件：$($latest.Name)" }
  "OK $($latest.Name)"
}

Write-Host ""
Write-Host ("结果：{0} 通过，{1} 失败" -f $pass, $fail)
if ($fail -gt 0) { exit 1 }
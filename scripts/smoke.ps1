param(
  [string]$PiHost = "192.0.2.10",
  [string]$PiUser = "antifield",
  [string]$AppUrl = "https://app.example.com",
  [string]$AiUrl = "https://ai.example.com",
  [switch]$SkipPublic
)

# 部署后冒烟：公网 HTTPS、Pi 本机服务、nftables、备份状态与端口暴露面。
$ErrorActionPreference = "Continue"
$target = "$PiUser@$PiHost"
$pass = 0
$fail = 0

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

if (-not $SkipPublic) {
  Check "公网 app 健康检查" {
    $code = & curl.exe -sS -o NUL -w "%{http_code}" --max-time 15 "$AppUrl/healthz"
    if ($code -ne "200") { throw "HTTP $code" }
    "HTTP 200"
  }
  Check "公网 ai 登录跳转/401" {
    $code = & curl.exe -sS -o NUL -w "%{http_code}" --max-time 15 "$AiUrl/"
    if ($code -ne "302" -and $code -ne "401") { throw "HTTP $code" }
    "HTTP $code"
  }
}

Check "Pi SSH 可达" {
  $out = & ssh.exe -o BatchMode=yes -o ConnectTimeout=10 $target "echo ok"
  if ($LASTEXITCODE -ne 0) { throw "ssh exit=$LASTEXITCODE" }
  ($out | Out-String).Trim()
}

Check "Pi 服务状态" {
  $out = & ssh.exe -o BatchMode=yes -o ConnectTimeout=10 $target "systemctl is-active antifieldcloud cloudflared nginx opencode minecraft | tr '\n' ' '"
  if ($LASTEXITCODE -ne 0) { throw "ssh exit=$LASTEXITCODE" }
  $text = ($out | Out-String).Trim()
  if ($text -notmatch "active active active active active") { throw $text }
  $text
}

Check "Pi 本机应用健康" {
  $out = & ssh.exe -o BatchMode=yes -o ConnectTimeout=10 $target "curl -fsS --max-time 5 http://127.0.0.1:3000/healthz"
  if ($LASTEXITCODE -ne 0) { throw "healthz 失败" }
  ($out | Out-String).Trim()
}

Check "nftables 规则生效" {
  $out = & ssh.exe -o BatchMode=yes -o ConnectTimeout=10 $target "sudo /usr/sbin/nft list ruleset | grep -c '25575'"
  if ($LASTEXITCODE -ne 0) { throw "nft 查询失败" }
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

Check "备份拉取状态" {
  $out = & ssh.exe -o BatchMode=yes -o ConnectTimeout=10 $target "cat /var/lib/antifieldcloud/backup-pull.json 2>/dev/null || echo NONE"
  $text = ($out | Out-String).Trim()
  if ($text -eq "NONE" -or $text -eq "") { throw "尚未完成首次拉取" }
  $text
}

Write-Host ""
Write-Host ("结果：{0} 通过，{1} 失败" -f $pass, $fail)
if ($fail -gt 0) { exit 1 }

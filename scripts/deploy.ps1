param(
  [string]$PiHost = "192.0.2.10",
  [string]$PiUser = "antifield",
  [switch]$SkipChecks,
  [switch]$SkipBuild
)

# 构建前端 → 打包 → 上传到 Pi 的 releases/<UTC> → 安装生产依赖 → 切换 current → 重启并健康检查。
# 前置：Pi 已完成服务账号/目录/systemd 初始化（见 docs/DEPLOY.md），并已运行 bootstrap-env.sh。
# Windows PowerShell 5.1 会把原生命令的 stderr 当作错误记录；这里用 Continue 并显式检查 $LASTEXITCODE。
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$target = "$PiUser@$PiHost"
$tag = (Get-Date).ToUniversalTime().ToString("yyyyMMdd'T'HHmmss'Z'")
$tarPath = Join-Path $env:TEMP "antifieldcloud-$tag.tar.gz"
$releaseDir = "/opt/antifieldcloud/releases/$tag"

function Invoke-Remote {
  param([string]$Command, [int]$Attempts = 3)
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    $output = & ssh.exe -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 $target $Command 2>&1
    if ($LASTEXITCODE -eq 0) { return $output }
    if ($attempt -eq $Attempts) {
      throw "远程命令失败（exit=$LASTEXITCODE）：$Command`n$output"
    }
    Write-Warning "SSH 第 $attempt 次失败，5 秒后重试…"
    Start-Sleep -Seconds 5
  }
}

function Copy-ToPi {
  param([string]$Local, [string]$Remote, [int]$Attempts = 3)
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    & scp.exe -o BatchMode=yes -o ConnectTimeout=10 $Local $Remote 2>&1 | Out-Host
    if ($LASTEXITCODE -eq 0) { return }
    if ($attempt -eq $Attempts) { throw "scp 失败（exit=$LASTEXITCODE）：$Local -> $Remote" }
    Write-Warning "scp 第 $attempt 次失败，5 秒后重试…"
    Start-Sleep -Seconds 5
  }
}

Push-Location $root
try {
  if (-not $SkipChecks) {
    Write-Host "== npm run check =="
    & npm run check
    if ($LASTEXITCODE -ne 0) { throw "npm run check 失败" }
  }
  if (-not $SkipBuild) {
    Write-Host "== npm run build =="
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build 失败" }
  }
  if (-not (Test-Path (Join-Path $root "web/dist/index.html"))) { throw "web/dist/index.html 不存在" }

  Write-Host "== 打包 $tag =="
  if (Test-Path $tarPath) { Remove-Item $tarPath -Force }
  & tar.exe -czf $tarPath -C $root server scripts web/dist deploy docs package.json package-lock.json README.md AGENTS.md
  if ($LASTEXITCODE -ne 0) { throw "打包失败" }

  Write-Host "== 上传 =="
  Invoke-Remote "sudo install -d -o root -g root -m 0755 /opt/antifieldcloud/releases" | Out-Null
  Copy-ToPi $tarPath "${target}:/tmp/antifieldcloud-$tag.tar.gz"

  Write-Host "== 解包与安装生产依赖 =="
  Invoke-Remote "sudo mkdir -p $releaseDir && sudo tar -xzf /tmp/antifieldcloud-$tag.tar.gz -C $releaseDir && sudo chown -R root:root $releaseDir && sudo chmod -R u+rwX,go-w $releaseDir && sudo rm -f /tmp/antifieldcloud-$tag.tar.gz" | Out-Null
  $install = "cd $releaseDir && sudo /usr/local/bin/npm ci --omit=dev --ignore-scripts --no-audit --no-fund && sudo chown -R root:root $releaseDir && sudo chmod -R u+rwX,go-w $releaseDir"
  Invoke-Remote $install | Out-Host

  Write-Host "== 切换 current 并重启 =="
  Invoke-Remote "sudo ln -sfn $releaseDir /opt/antifieldcloud/current && sudo systemctl restart antifieldcloud" | Out-Null

  Write-Host "== 健康检查 =="
  $ok = $false
  for ($i = 0; $i -lt 15; $i++) {
    try {
      $health = Invoke-Remote "curl -fsS --max-time 3 http://127.0.0.1:3000/healthz"
      Write-Host $health
      $ok = $true
      break
    } catch {
      Start-Sleep -Seconds 2
    }
  }
  if (-not $ok) {
    Invoke-Remote "sudo journalctl -u antifieldcloud --no-pager -n 60" | Out-Host
    throw "健康检查失败：请查看上方 journal；可用 docs/DEPLOY.md 的回滚步骤切回上一 release"
  }

  Write-Host "== 清理旧 release（保留 3 个）=="
  Invoke-Remote "ls -1dt /opt/antifieldcloud/releases/* | tail -n +4 | xargs -r sudo rm -rf" | Out-Null
  Write-Host "部署完成：$releaseDir"
} finally {
  Pop-Location
  if (Test-Path $tarPath) { Remove-Item $tarPath -Force -ErrorAction SilentlyContinue }
}

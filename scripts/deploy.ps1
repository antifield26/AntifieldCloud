param(
  [string]$PiHost = "192.0.2.10",
  [string]$PiUser = "antifield",
  [switch]$SkipChecks,
  [switch]$SkipBuild
)

# 构建前端 → 打包 → 上传到 Pi 的 releases/<UTC> → 安装生产依赖 → 迁移前 DB 快照 → 切换 current
# → 重启并健康检查；失败自动切回上一 release 并复检。
# 前置：Pi 已完成服务账号/目录/systemd 初始化（见 docs/DEPLOY.md），并已运行 bootstrap-env.sh。
# Windows PowerShell 5.1 会把原生命令的 stderr 当作错误记录；这里用 Continue 并显式检查 $LASTEXITCODE。
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$target = "$PiUser@$PiHost"
$tag = (Get-Date).ToUniversalTime().ToString("yyyyMMdd'T'HHmmss'Z'")
$tarPath = Join-Path $env:TEMP "antifieldcloud-$tag.tar.gz"
$releaseDir = "/opt/antifieldcloud/releases/$tag"
$currentLink = "/opt/antifieldcloud/current"
$previousTarget = $null
$snapshotJson = $null
$switched = $false

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

# 复杂远端脚本经 base64 传输，避免 Windows→PowerShell→ssh→bash 多层引号问题。
function Invoke-RemoteScript {
  param([string]$Script, [int]$Attempts = 3)
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Script))
  return Invoke-Remote "echo $b64 | base64 -d | sudo bash" -Attempts $Attempts
}

function ConvertFrom-JsonLine {
  param($Lines)
  $jsonLines = @($Lines | ForEach-Object { [string]$_ } | Where-Object { $_ -match '^\s*\{' })
  if ($jsonLines.Count -eq 0) { return $null }
  try { return ($jsonLines[$jsonLines.Count - 1] | ConvertFrom-Json) } catch { return $null }
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

function Test-Health {
  param([int]$Attempts = 15)
  for ($i = 0; $i -lt $Attempts; $i++) {
    try {
      $health = Invoke-Remote "curl -fsS --max-time 3 http://127.0.0.1:3000/healthz"
      Write-Host $health
      return $true
    } catch {
      Start-Sleep -Seconds 2
    }
  }
  return $false
}

function Invoke-CleanupOldReleases {
  # 保留最新 3 个 release；current 与本次 previous 永不删除。
  $prev = if ($previousTarget) { $previousTarget } else { "" }
  $script = @"
cur=`$(readlink -f $currentLink)
prev="$prev"
ls -1dt /opt/antifieldcloud/releases/* | awk -v c="`$cur" -v p="`$prev" 'NR>3 && `$0 != c && `$0 != p' | xargs -r sudo rm -rf
"@
  Invoke-RemoteScript $script | Out-Null
}

function Invoke-Rollback {
  param([string]$Reason)
  Write-Warning "健康检查失败：$Reason"
  try { Invoke-Remote "sudo journalctl -u antifieldcloud --no-pager -n 80" | Out-Host } catch { }
  if (-not $previousTarget) {
    Write-Warning "没有可回滚的上一 release（首次部署）。本次 release 保持 current，请人工处理。"
    return $false
  }
  Write-Warning "开始回滚到：$previousTarget"
  try {
    Invoke-Remote "sudo ln -sfn $previousTarget $currentLink" | Out-Null
    Invoke-Remote "sudo systemctl restart antifieldcloud" | Out-Null
  } catch {
    Write-Warning "回滚命令执行失败：$($_.Exception.Message)"
    Write-Warning "需要人工介入；迁移前 DB 快照：$(if ($snapshotJson) { $snapshotJson.snapshot } else { '无' })"
    return $false
  }
  $ok = Test-Health
  if ($ok) {
    Write-Host "回滚成功，应用已恢复到上一 release：$previousTarget"
    Write-Host "迁移前 DB 快照：$(if ($snapshotJson) { $snapshotJson.snapshot } else { '无' })"
    return $true
  }
  Write-Warning "回滚后健康检查仍失败，需要人工介入；迁移前 DB 快照：$(if ($snapshotJson) { $snapshotJson.snapshot } else { '无' })"
  return $false
}

Push-Location $root
try {
  if (-not (Test-Path (Join-Path $root "LICENSE"))) { throw "LICENSE 不存在（发布包必须包含 MIT 许可）" }
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
  & tar.exe -czf $tarPath -C $root server scripts web/dist deploy docs package.json package-lock.json README.md AGENTS.md CHANGELOG.md LICENSE
  if ($LASTEXITCODE -ne 0) { throw "打包失败" }

  Write-Host "== 上传 =="
  Invoke-Remote "sudo install -d -o root -g root -m 0755 /opt/antifieldcloud/releases" | Out-Null
  Copy-ToPi $tarPath "${target}:/tmp/antifieldcloud-$tag.tar.gz"
  $previousTarget = (Invoke-Remote "readlink -f $currentLink 2>/dev/null || true" | Out-String).Trim()
  if ($previousTarget -eq "") { $previousTarget = $null }
  Write-Host "上一 release：$(if ($previousTarget) { $previousTarget } else { '（无，首次部署）' })"

  Write-Host "== 解包与安装生产依赖 =="
  Invoke-Remote "sudo mkdir -p $releaseDir && sudo tar -xzf /tmp/antifieldcloud-$tag.tar.gz -C $releaseDir && sudo chown -R root:root $releaseDir && sudo chmod -R u+rwX,go-w $releaseDir && sudo rm -f /tmp/antifieldcloud-$tag.tar.gz" | Out-Null
  $install = "cd $releaseDir && sudo /usr/local/bin/npm ci --omit=dev --ignore-scripts --no-audit --no-fund && sudo chown -R root:root $releaseDir && sudo chmod -R u+rwX,go-w $releaseDir"
  Invoke-Remote $install | Out-Host

  $envReady = ((Invoke-Remote "test -f /etc/antifieldcloud/env && echo YES || echo NO" | Out-String).Trim() -match "YES")
  if (-not $envReady) {
    # 首次部署：env 尚未生成（第 2 节 bootstrap-env.sh），此时无法做 DB 快照/健康检查。
    Write-Warning "未找到 /etc/antifieldcloud/env：按首次部署处理，跳过迁移前快照、重启与健康检查。"
    Invoke-Remote "sudo ln -sfn $releaseDir $currentLink" | Out-Null
    $switched = $true
    Invoke-CleanupOldReleases
    Write-Host "首次代码部署完成：$releaseDir"
    Write-Host "下一步：cd $currentLink && sudo bash scripts/bootstrap-env.sh --dry-run（确认域名后去掉 --dry-run）"
    Write-Host "然后：sudo systemctl enable --now antifieldcloud"
    return
  }

  Write-Host "== 迁移前 DB 快照 =="
  $snapshotRaw = Invoke-Remote "cd $releaseDir && sudo -u antifieldcloud -H /usr/local/bin/node scripts/backup.mjs --snapshot-db"
  $snapshotJson = ConvertFrom-JsonLine $snapshotRaw
  if (-not $snapshotJson -or -not $snapshotJson.ok) {
    throw "迁移前 DB 快照失败：$snapshotRaw`n已停止部署，current 未切换。"
  }
  Write-Host "DB 快照：$($snapshotJson.snapshot)（sha256=$($snapshotJson.sha256)）"

  Write-Host "== 切换 current 并重启 =="
  # ln 与 restart 分开执行：只要 current 已切换就标记 switched，失败清理不会误删 current 目标。
  Invoke-Remote "sudo ln -sfn $releaseDir $currentLink" | Out-Null
  $switched = $true
  Invoke-Remote "sudo systemctl restart antifieldcloud" | Out-Null

  Write-Host "== 健康检查 =="
  if (-not (Test-Health)) {
    $rolledBack = Invoke-Rollback "新 release 未通过 /healthz"
    if ($previousTarget -and $rolledBack) {
      # 仅在 current 已切回上一 release 后清理坏 release，避免留下悬空 current。
      try { Invoke-Remote "sudo rm -rf $releaseDir" | Out-Null } catch { }
    }
    if ($previousTarget) {
      if ($rolledBack) {
        throw "部署失败，已回滚到上一 release：$previousTarget。坏 release 已清理；迁移前 DB 快照：$($snapshotJson.snapshot)"
      }
      throw "部署失败且回滚未通过健康检查，需人工介入：current 可能仍指向 $releaseDir；迁移前 DB 快照：$($snapshotJson.snapshot)"
    }
    throw "部署失败：首次部署无回滚目标（current 保持指向新 release，便于排查）。journalctl 日志见上方；迁移前 DB 快照：$($snapshotJson.snapshot)"
  }

  Write-Host "== 清理旧 release（保留 3 个，保护 current/previous）=="
  Invoke-CleanupOldReleases
  Write-Host "部署完成：$releaseDir"
  Write-Host "迁移前 DB 快照：$($snapshotJson.snapshot)"
} catch {
  if (-not $switched) {
    # 切换前失败：清理不完整 release 与远端临时包，current 保持原样。
    try { Invoke-Remote "sudo rm -rf $releaseDir" | Out-Null } catch { }
    try { Invoke-Remote "sudo rm -f /tmp/antifieldcloud-$tag.tar.gz" | Out-Null } catch { }
  }
  throw
} finally {
  Pop-Location
  if (Test-Path $tarPath) { Remove-Item $tarPath -Force -ErrorAction SilentlyContinue }
}
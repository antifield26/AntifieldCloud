param(
  [string]$PiHost = "192.0.2.10",
  [string]$PiUser = "antifield",
  [switch]$SkipChecks,
  [switch]$SkipBuild,
  [switch]$AllowDirty,
  [switch]$AllowSmokeFailure,
  [int]$CommandTimeoutSec = 120,
  [int]$InstallTimeoutSec = 1800
)

# 构建前端 → 打包 → 上传到 Pi 的 releases/<UTC> → 安装生产依赖 → 迁移前 DB 快照 → 切换 current
# → 重启并按 package.json 版本做健康检查；失败自动回滚（含还原迁移前 DB 快照）。
# 前置：Pi 已完成服务账号/目录/systemd 初始化（见 docs/DEPLOY.md），并已运行 bootstrap-env.sh。
# 约束：
# - 所有 ssh/scp 都有硬超时（Start-Process + taskkill /T /F），不会无限挂起；
# - 上传后校验远端 tar SHA-256；安装前校验远端 package.json 版本与本地一致；
# - APP_VERSION 注入 /etc/antifieldcloud/env，健康检查断言 /healthz.version（OP-04）；
# - 回滚前先停止服务并还原迁移前 DB 快照（schema 只向上、无 down，OP-05）；无快照则拒绝自动回滚并打印手工步骤。
# Windows PowerShell 5.1 会把原生命令的 stderr 当作错误记录；这里显式检查退出码。
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path -Parent $PSScriptRoot
$target = "$PiUser@$PiHost"
$tag = (Get-Date).ToUniversalTime().ToString("yyyyMMdd'T'HHmmss'Z'")
$tarPath = Join-Path $env:TEMP "antifieldcloud-$tag.tar.gz"
$releaseDir = "/opt/antifieldcloud/releases/$tag"
$currentLink = "/opt/antifieldcloud/current"
$envFile = "/etc/antifieldcloud/env"
$previousTarget = $null
$snapshotJson = $null
$switched = $false
$expectedVersion = $null

function ConvertTo-ArgumentString {
  param([string[]]$Arguments)
  $quoted = foreach ($argument in $Arguments) {
    if ($argument -match '[\s"]') { '"' + ($argument -replace '"', '\"') + '"' } else { $argument }
  }
  return ($quoted -join " ")
}

# 执行本地进程并硬超时：超时用 taskkill /T /F 杀整棵进程树。
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
      Label    = $Label
      ExitCode = $exitCode
      StdOut   = $stdoutText.Trim()
      StdErr   = $stderrText.Trim()
      Output   = ((@($stdoutText, $stderrText) -join "`n").Trim())
    }
  } finally {
    Remove-Item -Force $stdoutPath, $stderrPath -ErrorAction SilentlyContinue
  }
}

function Invoke-Remote {
  param([string]$Command, [int]$Attempts = 3, [int]$TimeoutSeconds = $CommandTimeoutSec)
  $lastResult = $null
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    $lastResult = Invoke-NativeWithTimeout -FilePath "ssh.exe" -Arguments @(
      "-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=2", $target, $Command
    ) -TimeoutSeconds $TimeoutSeconds -Label "ssh: $Command"
    if ($lastResult.ExitCode -eq 0) { return $lastResult.Output }
    if ($attempt -eq $Attempts) {
      throw "远程命令失败（exit=$($lastResult.ExitCode)）：$Command`n$($lastResult.Output)"
    }
    Write-Warning "SSH 第 $attempt 次失败，5 秒后重试…"
    Start-Sleep -Seconds 5
  }
}

# 复杂远端脚本经 base64 传输，避免 Windows→PowerShell→ssh→bash 多层引号问题。
function Invoke-RemoteScript {
  param([string]$Script, [int]$Attempts = 3, [int]$TimeoutSeconds = $CommandTimeoutSec)
  # 远端 bash 只接受 LF：PowerShell 字符串可能含 CRLF，先归一化。
  $normalized = $Script -replace "`r`n", "`n"
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($normalized))
  return Invoke-Remote "echo $b64 | base64 -d | sudo bash" -Attempts $Attempts -TimeoutSeconds $TimeoutSeconds
}

# 忽略非 JSON 日志行；解析失败时剥离非 ASCII 再试一次（OP-06）。
function ConvertFrom-JsonLine {
  param($Lines)
  $jsonLines = @($Lines | ForEach-Object { [string]$_ } | Where-Object { $_ -match '^\s*\{.*\}\s*$' })
  if ($jsonLines.Count -eq 0) { return $null }
  $candidate = $jsonLines[$jsonLines.Count - 1]
  try { return ($candidate | ConvertFrom-Json) } catch { }
  $asciiOnly = -join ($candidate.ToCharArray() | Where-Object { [int]$_ -ge 32 -and [int]$_ -lt 127 })
  try { return ($asciiOnly | ConvertFrom-Json) } catch { return $null }
}

function Copy-ToPi {
  param([string]$Local, [string]$Remote, [int]$Attempts = 3)
  $sizeMB = [Math]::Max(1, [Math]::Ceiling((Get-Item -LiteralPath $Local).Length / [double]1MB))
  $timeout = [int][Math]::Min(3600, [Math]::Max(300, $sizeMB * 20))
  $lastResult = $null
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    $lastResult = Invoke-NativeWithTimeout -FilePath "scp.exe" -Arguments @(
      "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=2", $Local, "${target}:$Remote"
    ) -TimeoutSeconds $timeout -Label "scp: $Local -> $Remote"
    if ($lastResult.ExitCode -eq 0) { return }
    if ($attempt -eq $Attempts) { throw "scp 失败（exit=$($lastResult.ExitCode)）：$Local -> $Remote`n$($lastResult.Output)" }
    Write-Warning "scp 第 $attempt 次失败，5 秒后重试…"
    Start-Sleep -Seconds 5
  }
}

# 健康检查：解析 /healthz JSON，断言 version 与本地 package.json 一致（OP-04）。
function Test-Health {
  param([int]$Attempts = 15)
  for ($i = 0; $i -lt $Attempts; $i++) {
    $raw = $null
    try { $raw = Invoke-Remote "curl -fsS --max-time 3 http://127.0.0.1:3000/healthz" -Attempts 1 -TimeoutSeconds 20 } catch { $raw = $null }
    if ($raw) {
      $health = ConvertFrom-JsonLine @($raw)
      if ($health -and $expectedVersion) {
        if ([string]$health.version -eq [string]$expectedVersion) {
          Write-Host ("healthz ok：version=" + $health.version)
          return $true
        }
        Write-Warning ("healthz version 不匹配：期望 $expectedVersion，实际 $($health.version)")
      } elseif ($health) {
        Write-Host $raw
        return $true
      }
    }
    Start-Sleep -Seconds 2
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

# 回滚：先停服务 →（有迁移前快照时）还原 DB → 切回上一 release → 启动 → 健康检查。
# 没有快照则拒绝自动回滚，打印手工步骤，避免“回滚成功但 schema 不兼容”的假成功（OP-05）。
function Invoke-Rollback {
  param([string]$Reason)
  Write-Warning "健康检查失败：$Reason"
  try { Invoke-Remote "sudo journalctl -u antifieldcloud --no-pager -n 80" | Out-Host } catch { }
  if (-not $previousTarget) {
    Write-Warning "没有可回滚的上一 release（首次部署）。本次 release 保持 current，请人工处理。"
    return $false
  }
  if (-not $snapshotJson -or -not $snapshotJson.snapshot) {
    Write-Warning "没有迁移前 DB 快照，拒绝自动回滚（新 release 可能已执行 schema 迁移）。"
    Write-Warning "手工回滚步骤：1) sudo systemctl stop antifieldcloud；2) 找到 /var/lib/antifieldcloud/backups/db-predeploy-*.sqlite 最新一份；"
    Write-Warning "3) 复制为 db.sqlite 并删除 -wal/-shm；4) sudo ln -sfn $previousTarget $currentLink；5) sudo systemctl start antifieldcloud；6) 重新验证 /healthz。"
    return $false
  }
  Write-Warning "开始回滚到：$previousTarget（先还原迁移前 DB 快照：$($snapshotJson.snapshot)）"
  # 回滚必须同时还原 APP_VERSION；否则旧 release 会以新版本号通过 /healthz（OPS4-03）。
  $prevVersion = ""
  try {
    $prevVersion = (Invoke-Remote "sudo /usr/local/bin/node -p \"require('$previousTarget/package.json').version\"" -Attempts 2 | Out-String).Trim()
  } catch { }
  if ($prevVersion -notmatch '^\d+\.\d+\.\d+$') {
    Write-Warning "无法读取上一 release 版本号，拒绝自动回滚以免健康检查假阳性。"
    return $false
  }
  $rollbackScript = @"
set -e
sudo systemctl stop antifieldcloud
sudo cp -a '$($snapshotJson.snapshot)' /var/lib/antifieldcloud/db.sqlite
sudo rm -f /var/lib/antifieldcloud/db.sqlite-wal /var/lib/antifieldcloud/db.sqlite-shm
sudo chown antifieldcloud:antifieldcloud /var/lib/antifieldcloud/db.sqlite
sudo chmod 0640 /var/lib/antifieldcloud/db.sqlite
if grep -q '^APP_VERSION=' /etc/antifieldcloud/env; then
  sudo sed -i 's/^APP_VERSION=.*/APP_VERSION=$prevVersion/' /etc/antifieldcloud/env
else
  printf 'APP_VERSION=%s\n' '$prevVersion' | sudo tee -a /etc/antifieldcloud/env >/dev/null
fi
sudo ln -sfn $previousTarget $currentLink
sudo systemctl start antifieldcloud
"@
  try {
    Invoke-RemoteScript $rollbackScript -TimeoutSeconds 300 | Out-Null
  } catch {
    Write-Warning "回滚命令执行失败：$($_.Exception.Message)"
    Write-Warning "需要人工介入；迁移前 DB 快照：$($snapshotJson.snapshot)"
    return $false
  }
  $ok = Test-Health
  if ($ok) {
    Write-Host "回滚成功：已还原迁移前 DB 快照并切回上一 release：$previousTarget"
    return $true
  }
  Write-Warning "回滚后健康检查仍失败，需要人工介入；迁移前 DB 快照：$($snapshotJson.snapshot)"
  return $false
}

Push-Location $root
try {
  if (-not (Test-Path (Join-Path $root "LICENSE"))) { throw "LICENSE 不存在（发布包必须包含 MIT 许可）" }

  # 发布必须绑定干净的 commit（OPS4-04）：避免把未提交的 v0.5.0 半成品当成旧版本发布。
  if (Test-Path (Join-Path $root ".git")) {
    $dirty = @(& git -C $root status --porcelain 2>$null)
    if ($dirty.Count -gt 0 -and -not $AllowDirty) {
      throw "工作树不干净（$($dirty.Count) 个文件）；请先提交或使用 -AllowDirty 明确允许脏发布"
    }
    $headSha = (& git -C $root rev-parse --short HEAD 2>$null | Out-String).Trim()
    Write-Host "发布 commit：$headSha$(if ($dirty.Count -gt 0) { '（含未提交改动）' })"
  }

  # 期望版本来自本地 package.json（发布包内同一份文件）；上传后还会与远端副本比对。
  $packagePath = Join-Path $root "package.json"
  $packageText = [System.IO.File]::ReadAllText($packagePath, [System.Text.Encoding]::UTF8)
  $packageJson = $packageText | ConvertFrom-Json
  $expectedVersion = [string]$packageJson.version
  if ($expectedVersion -notmatch '^\d+\.\d+\.\d+$') { throw "package.json version 非法：$expectedVersion" }
  Write-Host "目标版本：$expectedVersion"

  # 远程环境预检（OP-24）：Node/NPM 可用、版本足够；部署前不修改任何服务状态。
  Write-Host "== 远程环境预检 =="
  $nodeVersion = (Invoke-Remote "sudo /usr/local/bin/node --version" -Attempts 3 | Out-String).Trim()
  $nodeMatch = [regex]::Match($nodeVersion, '^v(\d+)\.')
  if (-not $nodeMatch.Success) { throw "Pi 上 /usr/local/bin/node 不可用：$nodeVersion" }
  if ([int]$nodeMatch.Groups[1].Value -lt 26) { throw "Pi 上 Node 版本过低（$nodeVersion），要求 >= 26" }
  $npmVersion = (Invoke-Remote "sudo /usr/local/bin/npm --version" -Attempts 3 | Out-String).Trim()
  if ($npmVersion -notmatch '^\d+\.\d+\.\d+') { throw "Pi 上 /usr/local/bin/npm 不可用：$npmVersion（检查 nvm 链接，不要删除当前版本）" }
  Write-Host "node=$nodeVersion npm=$npmVersion"

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
  $tarSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $tarPath).Hash.ToLower()
  $tarSize = (Get-Item -LiteralPath $tarPath).Length
  Write-Host "本地包：$tarPath（$tarSize bytes，sha256=$tarSha256）"

  # 空间预检（OP-25）：至少 2 GiB + 包体大小。
  $freeText = (Invoke-Remote "df -Pk /opt/antifieldcloud 2>/dev/null | awk 'NR==2{print `$4}'" -Attempts 3 | Out-String).Trim()
  $freeKb = [long]0
  if (-not [long]::TryParse($freeText, [ref]$freeKb)) { throw "无法读取 Pi 根分区可用空间：$freeText" }
  $requiredBytes = [long](2GB) + $tarSize
  if ($freeKb -le 0) { throw "无法读取 Pi 根分区可用空间" }
  if (($freeKb * 1024) -lt $requiredBytes) {
    throw ("Pi 磁盘空间不足：可用 {0:N1} MiB，需要 {1:N1} MiB（2 GiB 预留 + 包体）" -f ($freeKb / 1024), ($requiredBytes / 1MB))
  }
  Write-Host ("Pi 可用空间：{0:N1} MiB（需要 >= {1:N1} MiB）" -f ($freeKb / 1024), ($requiredBytes / 1MB))

  Write-Host "== 上传 =="
  Invoke-Remote "sudo install -d -o root -g root -m 0755 /opt/antifieldcloud/releases" | Out-Null
  Copy-ToPi $tarPath "/tmp/antifieldcloud-$tag.tar.gz"
  $remoteSha = (Invoke-Remote "sha256sum /tmp/antifieldcloud-$tag.tar.gz | cut -d' ' -f1" -Attempts 3 | Out-String).Trim().ToLower()
  if ($remoteSha -ne $tarSha256) {
    try { Invoke-Remote "sudo rm -f /tmp/antifieldcloud-$tag.tar.gz" | Out-Null } catch { }
    throw "上传后 SHA-256 不一致：本地 $tarSha256 / 远端 $remoteSha"
  }
  Write-Host "上传校验通过（sha256 一致）"
  $previousTarget = (Invoke-Remote "readlink -f $currentLink 2>/dev/null || true" | Out-String).Trim()
  if ($previousTarget -eq "") { $previousTarget = $null }
  Write-Host "上一 release：$(if ($previousTarget) { $previousTarget } else { '（无，首次部署）' })"
  if ($previousTarget) {
    $enabled = (Invoke-Remote "systemctl is-enabled antifieldcloud 2>/dev/null || true" -Attempts 1 | Out-String).Trim()
    if ($enabled -ne "enabled") { throw "antifieldcloud.service 未启用（is-enabled=$enabled），请先修复部署状态" }
  }

  Write-Host "== 解包与安装生产依赖 =="
  Invoke-Remote "sudo mkdir -p $releaseDir && sudo tar -xzf /tmp/antifieldcloud-$tag.tar.gz -C $releaseDir && sudo chown -R root:root $releaseDir && sudo chmod -R u+rwX,go-w $releaseDir && sudo rm -f /tmp/antifieldcloud-$tag.tar.gz" -TimeoutSeconds 900 | Out-Null
  # 远端 release 版本必须与本地一致（防止打包/上传错版本）：读取远端 package.json。
  $remotePackageText = (Invoke-Remote "cat $releaseDir/package.json" -Attempts 2 | Out-String)
  try {
    $remotePackageJson = $remotePackageText | ConvertFrom-Json
  } catch {
    throw "无法解析远端 release package.json：$remotePackageText"
  }
  $remoteVersion = [string]$remotePackageJson.version
  if ($remoteVersion -ne $expectedVersion) {
    throw "远端 release 版本（$remoteVersion）与本地 package.json（$expectedVersion）不一致"
  }
  $install = "cd $releaseDir && sudo /usr/local/bin/npm ci --omit=dev --ignore-scripts --no-audit --no-fund && sudo chown -R root:root $releaseDir && sudo chmod -R u+rwX,go-w $releaseDir"
  $installResult = Invoke-NativeWithTimeout -FilePath "ssh.exe" -Arguments @(
    "-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2", $target, $install
  ) -TimeoutSeconds $InstallTimeoutSec -Label "npm ci"
  $installResult.Output | Out-Host
  if ($installResult.ExitCode -ne 0) { throw "npm ci 失败（exit=$($installResult.ExitCode)）" }

  $envReady = ((Invoke-Remote "test -f $envFile && echo YES || echo NO" | Out-String).Trim() -match "YES")
  if (-not $envReady) {
    # 首次部署：env 尚未生成（bootstrap-env.sh），此时无法做 DB 快照/健康检查。
    Write-Warning "未找到 $envFile：按首次部署处理，跳过迁移前快照、重启与健康检查。"
    Invoke-Remote "sudo ln -sfn $releaseDir $currentLink" | Out-Null
    $switched = $true
    Invoke-CleanupOldReleases
    Write-Host "首次代码部署完成：$releaseDir"
    Write-Host "下一步：cd $currentLink && sudo bash scripts/bootstrap-env.sh --dry-run（确认域名后去掉 --dry-run）"
    Write-Host "然后：sudo systemctl enable --now antifieldcloud"
    return
  }

  Write-Host "== 迁移前 DB 快照 =="
  $snapshotRaw = Invoke-Remote "cd $releaseDir && sudo -u antifieldcloud -H /usr/local/bin/node scripts/backup.mjs --snapshot-db" -TimeoutSeconds 600
  $snapshotJson = ConvertFrom-JsonLine $snapshotRaw
  if (-not $snapshotJson -or -not $snapshotJson.ok) {
    throw "迁移前 DB 快照失败：$snapshotRaw`n已停止部署，current 未切换。"
  }
  Write-Host "DB 快照：$($snapshotJson.snapshot)（sha256=$($snapshotJson.sha256)）"

  # APP_VERSION 注入 env（OP-04）：只改这一行，不重写 env 其它内容。
  $versionScript = @"
set -e
if grep -q '^APP_VERSION=' '$envFile'; then
  sudo sed -i 's/^APP_VERSION=.*/APP_VERSION=$expectedVersion/' '$envFile'
else
  printf 'APP_VERSION=%s\n' '$expectedVersion' | sudo tee -a '$envFile' >/dev/null
fi
"@
  Invoke-RemoteScript $versionScript | Out-Null
  $appVersion = (Invoke-Remote "sudo grep '^APP_VERSION=' $envFile | cut -d= -f2-" -Attempts 2 | Out-String).Trim()
  if ($appVersion -ne $expectedVersion) { throw "APP_VERSION 注入失败：期望 $expectedVersion，实际 $appVersion" }

  Write-Host "== 切换 current 并重启 =="
  # ln 与 restart 分开执行：只要 current 已切换就标记 switched，失败清理不会误删 current 目标。
  Invoke-Remote "sudo ln -sfn $releaseDir $currentLink" | Out-Null
  $switched = $true
  Invoke-Remote "sudo systemctl restart antifieldcloud" | Out-Null

  Write-Host "== 健康检查（断言 version=$expectedVersion）=="
  if (-not (Test-Health)) {
    $rolledBack = Invoke-Rollback "新 release 未通过 /healthz（version=$expectedVersion）"
    if ($previousTarget -and $rolledBack) {
      # 仅在 current 已切回上一 release 后清理坏 release，避免留下悬空 current。
      try { Invoke-Remote "sudo rm -rf $releaseDir" | Out-Null } catch { }
    }
    if ($previousTarget) {
      if ($rolledBack) {
        throw "部署失败，已回滚到上一 release 并还原迁移前 DB 快照：$previousTarget"
      }
      throw "部署失败且自动回滚未完成，需人工介入：current 可能仍指向 $releaseDir；迁移前 DB 快照：$($snapshotJson.snapshot)"
    }
    throw "部署失败：首次部署无回滚目标（current 保持指向新 release，便于排查）。journalctl 日志见上方；迁移前 DB 快照：$($snapshotJson.snapshot)"
  }

  Write-Host "== 清理旧 release（保留 3 个，保护 current/previous）=="
  Invoke-CleanupOldReleases
  Write-Host "部署完成：$releaseDir（version=$expectedVersion）"
  Write-Host "迁移前 DB 快照：$($snapshotJson.snapshot)"

  # 只读 smoke 子集（OP-13）：公网/本地备份归档检查跳过，Pi 服务与版本必须通过。
  $smokePath = Join-Path $PSScriptRoot "smoke.ps1"
  if (Test-Path $smokePath) {
    Write-Host "== 部署后只读 smoke =="
    & $smokePath -PiHost $PiHost -PiUser $PiUser -SkipPublic -SkipLocalBackup -ExpectedVersion $expectedVersion -ExpectedSchemaVersion 13
    if ($LASTEXITCODE -ne 0) {
      if ($AllowSmokeFailure) {
        Write-Warning "部署后 smoke 失败（已使用 -AllowSmokeFailure，部署保留；请根据上方 FAIL 项排查）"
      } else {
        throw "部署后 smoke 失败；发布门禁未通过（可用 -AllowSmokeFailure 仅告警）"
      }
    }
  }
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

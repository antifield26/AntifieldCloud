param(
  [string]$PiHost = "169.254.77.10",
  [string]$PiUser = "antifield",
  [switch]$SkipChecks,
  [switch]$AllowDirty,
  [switch]$Provision,
  [switch]$ServerConfig,
  [switch]$SkipServiceSwitch,
  [int]$HealthTimeoutSec = 90
)

# 部署 mcbot（原 lofii-bot）到 /opt/mcbot/releases/<UTC>，切换 symlink、重启、校验 /healthz，
# 失败自动回滚上一 release。v1.0.0 起为 workspace 感知布局：release 根 = 根 package/lock + apps/mcbot，
# systemd WorkingDirectory = /opt/mcbot/current/apps/mcbot。
# 首次部署：.\apps\mcbot\scripts\deploy.ps1 -Provision -ServerConfig -AllowDirty
# v1.0.0 生产切换：先 -SkipServiceSwitch 安装 release（不启动 mcbot），再执行
# .\scripts\migrate-v1.0.0.ps1 -Mode Apply 完成用户/环境/服务/数据切换。

$ErrorActionPreference = "Stop"
try { $PSNativeCommandUseErrorActionPreference = $false } catch { }
$repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$packageRoot = Join-Path $repoRoot "apps/mcbot"
$target = "$PiUser@$PiHost"
$tag = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$tarPath = Join-Path $env:TEMP "mcbot-$tag.tar.gz"
$stageDir = Join-Path $env:TEMP "mcbot-stage-$tag"
$releaseDir = "/opt/mcbot/releases/$tag"
$currentLink = "/opt/mcbot/current"
$previousTarget = ""
$expectedVersion = ""
$switched = $false

function Invoke-Remote {
  param([string]$Command, [int]$TimeoutSeconds = 120, [string]$Label = "")
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $out = & ssh.exe -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 $target $Command 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldPreference
  }
  return [pscustomobject]@{
    Code = $code
    Output = (($out | ForEach-Object { "$_" }) -join "`n").Trim()
  }
}

function Must-Remote {
  param([string]$Command, [string]$Label, [int]$TimeoutSeconds = 120)
  $result = Invoke-Remote -Command $Command -TimeoutSeconds $TimeoutSeconds
  if ($result.Code -ne 0) {
    throw "$Label failed (exit $($result.Code)): $($result.Output)"
  }
  return $result.Output
}

try {
  Push-Location $repoRoot

  if (-not $AllowDirty) {
    $dirty = (& git.exe status --porcelain) -join "`n"
    if ($dirty.Trim() -ne "") {
      throw "working tree is dirty; commit the changes or pass -AllowDirty"
    }
  }

  $package = Get-Content -LiteralPath (Join-Path $packageRoot "package.json") -Raw | ConvertFrom-Json
  $expectedVersion = [string]$package.version
  if ([string]::IsNullOrWhiteSpace($expectedVersion)) {
    throw "apps/mcbot/package.json has no version"
  }
  Write-Host "mcbot deploy: version $expectedVersion -> $target ($releaseDir)"

  if (-not $SkipChecks) {
    Write-Host "== local checks =="
    # Windows PowerShell 5.1 会把 npm 的 stderr（npm notice）当作 NativeCommandError；
    # 局部切到 Continue，仅以退出码判断，避免误判本地门禁失败。
    $oldErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & npm.cmd run check:mcbot 2>&1 | Write-Host
    $checkCode = $LASTEXITCODE
    $ErrorActionPreference = $oldErrorActionPreference
    if ($checkCode -ne 0) {
      throw "npm run check:mcbot failed"
    }
  }

  Write-Host "== packaging (workspace-aware staging) =="
  if (Test-Path -LiteralPath $tarPath) { Remove-Item -LiteralPath $tarPath -Force }
  if (Test-Path -LiteralPath $stageDir) { Remove-Item -LiteralPath $stageDir -Recurse -Force }
  $stagePackage = Join-Path $stageDir "apps/mcbot"
  New-Item -ItemType Directory -Path $stagePackage -Force | Out-Null
  Copy-Item (Join-Path $repoRoot "package.json"), (Join-Path $repoRoot "package-lock.json") $stageDir
  Copy-Item (Join-Path $packageRoot "*") $stagePackage -Recurse -Force
  foreach ($excluded in @("node_modules", "data", "data-local", "coverage", "*.tar.gz")) {
    Get-ChildItem -Path (Join-Path $stagePackage $excluded) -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  }
  & tar.exe -czf $tarPath -C $stageDir .
  if ($LASTEXITCODE -ne 0) {
    throw "tar packaging failed"
  }
  $sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $tarPath).Hash.ToLower()
  Write-Host "sha256=$sha"

  Must-Remote -Command "true" -Label "ssh connectivity" | Out-Null
  & scp.exe -q -o BatchMode=yes $tarPath "$($target):/tmp/mcbot-$tag.tar.gz"
  if ($LASTEXITCODE -ne 0) {
    throw "scp upload failed"
  }
  $remoteSha = (Must-Remote -Command "sha256sum /tmp/mcbot-$tag.tar.gz | cut -d' ' -f1" -Label "remote sha256").Trim().ToLower()
  if ($remoteSha -ne $sha) {
    throw "remote sha256 mismatch: local=$sha remote=$remoteSha"
  }

  Write-Host "== installing release =="
  $install = "sudo install -d -m 0755 $releaseDir && sudo tar -xzf /tmp/mcbot-$tag.tar.gz -C $releaseDir && cd $releaseDir && sudo timeout 900 /usr/local/bin/npm ci --omit=dev --ignore-scripts --no-audit --no-fund && sudo chown -R root:root $releaseDir && sudo chmod -R u+rwX,go-w $releaseDir"
  Must-Remote -Command $install -Label "install release" | Write-Host

  $previousTarget = (Invoke-Remote -Command "readlink -f $currentLink 2>/dev/null || true" -Label "read current").Output
  if ($previousTarget -eq "") {
    $previousTarget = ""
    Write-Host "no previous release (first deploy)"
  } else {
    Write-Host "previous release: $previousTarget"
  }

  if ($Provision) {
    Write-Host "== provisioning =="
    $serverFlag = ""
    if ($ServerConfig) { $serverFlag = " --server-config" }
    $provisionOutput = Must-Remote -Command "cd $releaseDir && sudo bash apps/mcbot/deploy/provision.sh$serverFlag" -Label "provision" -TimeoutSeconds 300
    Write-Host $provisionOutput
  }

  Write-Host "== switching current and restarting =="
  Must-Remote -Command "sudo ln -sfn $releaseDir $currentLink" -Label "switch current" | Out-Null
  $switched = $true
  if ($SkipServiceSwitch) {
    Write-Host "SkipServiceSwitch: release installed and current switched; mcbot.service not started."
    Write-Host "next: .\scripts\migrate-v1.0.0.ps1 -Mode Plan, then -Mode Apply"
    Write-Host "release: $releaseDir"
    return
  }
  Must-Remote -Command "sudo systemctl restart mcbot.service" -Label "restart mcbot" | Out-Null

  Write-Host "== health check =="
  $healthy = $false
  $lastHealth = ""
  $attempts = [Math]::Max(1, [Math]::Ceiling($HealthTimeoutSec / 3))
  for ($i = 1; $i -le $attempts; $i++) {
    Start-Sleep -Seconds 3
    $healthText = (Invoke-Remote -Command "curl -fsS --max-time 5 http://127.0.0.1:3010/healthz 2>/dev/null || true" -Label "healthz").Output
    if ($healthText -ne "") {
      $lastHealth = $healthText
      try {
        $health = $healthText | ConvertFrom-Json
        if ([string]$health.version -eq $expectedVersion) {
          $healthy = $true
          break
        }
      } catch {
        # wait for next attempt
      }
    }
  }

  if (-not $healthy) {
    Write-Host "health check failed; rolling back"
    if ($previousTarget -ne "") {
      Must-Remote -Command "sudo ln -sfn $previousTarget $currentLink" -Label "rollback symlink" | Out-Null
      Must-Remote -Command "sudo systemctl restart mcbot.service" -Label "rollback restart" | Out-Null
      $switched = $false
    }
    $logs = (Invoke-Remote -Command "sudo journalctl -u mcbot -n 80 --no-pager" -Label "journal").Output
    throw "health check failed (expected version $expectedVersion, last response '$lastHealth').`n$logs"
  }

  Write-Host "== deployed =="
  Write-Host (Invoke-Remote -Command "sudo systemctl is-active mcbot.service; curl -fsS --max-time 5 http://127.0.0.1:3010/healthz" -Label "final").Output
  Write-Host "release: $releaseDir"
  Write-Host "rollback: sudo ln -sfn <previous> $currentLink && sudo systemctl restart mcbot"
}
catch {
  Write-Host "DEPLOY FAILED: $($_.Exception.Message)" -ForegroundColor Red
  if ($switched -and $previousTarget -ne "") {
    Write-Host "attempting rollback to $previousTarget"
    try {
      Must-Remote -Command "sudo ln -sfn $previousTarget $currentLink" -Label "rollback symlink" | Out-Null
      Must-Remote -Command "sudo systemctl restart mcbot.service" -Label "rollback restart" | Out-Null
    } catch {
      Write-Host "rollback also failed: $($_.Exception.Message)" -ForegroundColor Red
    }
  }
  exit 1
}
finally {
  if (Test-Path -LiteralPath $tarPath) { Remove-Item -LiteralPath $tarPath -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $stageDir) { Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue }
  Pop-Location
}

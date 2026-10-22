param(
  [string]$PiHost = "169.254.77.10",
  [string]$PiUser = "antifield",
  [switch]$SkipChecks,
  [switch]$AllowDirty,
  [switch]$Provision,
  [switch]$ServerConfig,
  [int]$HealthTimeoutSec = 90
)

# Deploy Lofii to /opt/lofii-bot/releases/<UTC>, switch the symlink, restart,
# validate /healthz, and roll back to the previous release on failure.
# First run: .\scripts\deploy.ps1 -Provision -ServerConfig -AllowDirty

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$target = "$PiUser@$PiHost"
$tag = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$tarPath = Join-Path $env:TEMP "lofii-bot-$tag.tar.gz"
$releaseDir = "/opt/lofii-bot/releases/$tag"
$currentLink = "/opt/lofii-bot/current"
$previousTarget = ""
$expectedVersion = ""
$switched = $false

function Invoke-Remote {
  param([string]$Command, [int]$TimeoutSeconds = 120, [string]$Label = "")
  $out = & ssh.exe -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 $target $Command 2>&1
  $code = $LASTEXITCODE
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
  Push-Location $root

  if (-not $AllowDirty) {
    $dirty = (& git.exe status --porcelain) -join "`n"
    if ($dirty.Trim() -ne "") {
      throw "working tree is dirty; commit the changes or pass -AllowDirty"
    }
  }

  $package = Get-Content -LiteralPath (Join-Path $root "package.json") -Raw | ConvertFrom-Json
  $expectedVersion = [string]$package.version
  if ([string]::IsNullOrWhiteSpace($expectedVersion)) {
    throw "package.json has no version"
  }
  Write-Host "Lofii deploy: version $expectedVersion -> $target ($releaseDir)"

  if (-not $SkipChecks) {
    Write-Host "== local checks =="
    & npm.cmd run check
    if ($LASTEXITCODE -ne 0) {
      throw "npm run check failed"
    }
  }

  if (Test-Path -LiteralPath $tarPath) { Remove-Item -LiteralPath $tarPath -Force }
  Write-Host "== packaging =="
  & tar.exe -czf $tarPath --exclude=node_modules --exclude=.git --exclude=data --exclude=data-local --exclude=coverage --exclude=*.tar.gz -C $root .
  if ($LASTEXITCODE -ne 0) {
    throw "tar packaging failed"
  }
  $sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $tarPath).Hash.ToLower()
  Write-Host "sha256=$sha"

  Must-Remote -Command "true" -Label "ssh connectivity" | Out-Null
  & scp.exe -q -o BatchMode=yes $tarPath "$($target):/tmp/lofii-bot-$tag.tar.gz"
  if ($LASTEXITCODE -ne 0) {
    throw "scp upload failed"
  }
  $remoteSha = (Must-Remote -Command "sha256sum /tmp/lofii-bot-$tag.tar.gz | cut -d' ' -f1" -Label "remote sha256").Trim().ToLower()
  if ($remoteSha -ne $sha) {
    throw "remote sha256 mismatch: local=$sha remote=$remoteSha"
  }

  Write-Host "== installing release =="
  $install = "sudo install -d -m 0755 $releaseDir && sudo tar -xzf /tmp/lofii-bot-$tag.tar.gz -C $releaseDir && cd $releaseDir && sudo timeout 900 /usr/local/bin/npm ci --omit=dev --ignore-scripts --no-audit --no-fund && sudo chown -R root:root $releaseDir"
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
    $provisionOutput = Must-Remote -Command "cd $releaseDir && sudo bash deploy/provision.sh$serverFlag" -Label "provision" -TimeoutSeconds 300
    Write-Host $provisionOutput
  }

  Write-Host "== switching current and restarting =="
  Must-Remote -Command "sudo ln -sfn $releaseDir $currentLink" -Label "switch current" | Out-Null
  $switched = $true
  Must-Remote -Command "sudo systemctl restart lofii-bot.service" -Label "restart lofii-bot" | Out-Null

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
      Must-Remote -Command "sudo systemctl restart lofii-bot.service" -Label "rollback restart" | Out-Null
      $switched = $false
    }
    $logs = (Invoke-Remote -Command "sudo journalctl -u lofii-bot -n 80 --no-pager" -Label "journal").Output
    throw "health check failed (expected version $expectedVersion, last response '$lastHealth').`n$logs"
  }

  Write-Host "== deployed =="
  Write-Host (Invoke-Remote -Command "sudo systemctl is-active lofii-bot.service; curl -fsS --max-time 5 http://127.0.0.1:3010/healthz" -Label "final").Output
  Write-Host "release: $releaseDir"
  Write-Host "rollback: sudo ln -sfn <previous> $currentLink && sudo systemctl restart lofii-bot"
}
catch {
  Write-Host "DEPLOY FAILED: $($_.Exception.Message)" -ForegroundColor Red
  if ($switched -and $previousTarget -ne "") {
    Write-Host "attempting rollback to $previousTarget"
    try {
      Must-Remote -Command "sudo ln -sfn $previousTarget $currentLink" -Label "rollback symlink" | Out-Null
      Must-Remote -Command "sudo systemctl restart lofii-bot.service" -Label "rollback restart" | Out-Null
    } catch {
      Write-Host "rollback also failed: $($_.Exception.Message)" -ForegroundColor Red
    }
  }
  exit 1
}
finally {
  if (Test-Path -LiteralPath $tarPath) {
    Remove-Item -LiteralPath $tarPath -Force -ErrorAction SilentlyContinue
  }
  Pop-Location
}

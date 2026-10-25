param(
  [string]$BackupRoot = (Join-Path $env:USERPROFILE "AntifieldCloudBackups"),
  [string]$PiHost = "192.0.2.10",
  [string]$PiUser = "antifield",
  [string]$Remote = "",
  [string]$RemotePath = "",
  [string]$RemoteLabel = "",
  [int]$KeepDays = 30,
  [int]$MaxDelete = 50,
  [switch]$DryRun,
  [switch]$NoStatusWrite,
  [string]$NodeExe = "node",
  [string]$NodeScriptPath = (Join-Path $PSScriptRoot "backup-offsite.mjs"),
  [string]$RcloneBin = "rclone",
  [string]$StatusPath = "/var/lib/antifieldcloud/backup-offsite-status.json",
  [int]$CommandTimeoutSec = 1800
)

# 异地副本（PC 端，每日/每周手动或计划任务）：只把加密归档（.tar.gz.age + .sha256 + .meta.json）
# 复制到远端（rclone），并做链感知保留。明文归档一律不上传。
#
# 设计边界：
# - 本脚本绝不读取 age 私钥、不打印远端凭据；node 端只接受密文，明文计入 plaintextSkipped；
# - 状态 JSON 写回 Pi（0644，应用只读）供 Dashboard/offsite_overdue 告警使用；
#   状态字段：lastRunAt/ok/remoteLabel/uploaded/skipped/failed/bytes/keptRemote/plaintextSkipped/error；
# - 失败也尝试写 ok=false 状态（便于告警），但状态写失败不改变 node 的退出码判定；
# - 所有本地进程带硬超时（taskkill /T /F 杀进程树）；
# - 未配置 -Remote 时默认不运行（exit 2 并写 ok=false 状态），避免计划任务误报成功。
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$target = "$PiUser@$PiHost"
$base = Join-Path $env:LOCALAPPDATA "AntifieldCloud"
$logPath = Join-Path $base "backup-offsite.log"
$statusTmp = Join-Path $env:TEMP ("antifieldcloud-offsite-" + [guid]::NewGuid().ToString("N") + ".json")
New-Item -ItemType Directory -Force -Path $base | Out-Null

# 日志超过 1 MiB 轮转一次。
if ((Test-Path $logPath) -and ((Get-Item $logPath).Length -gt 1MB)) {
  Move-Item -Force $logPath "$logPath.1"
}

function Write-Log {
  param([string]$Message)
  $line = "{0} {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -Path $logPath -Value $line -Encoding UTF8
  Write-Host $line
}

function ConvertTo-ArgumentString {
  param([string[]]$Arguments)
  $quoted = foreach ($argument in $Arguments) {
    if ($argument -match '[\s"]') { '"' + ($argument -replace '"', '\"') + '"' } else { $argument }
  }
  return ($quoted -join " ")
}

# 执行本地进程并硬超时：超时 taskkill /T /F 杀整棵进程树（与 deploy/backup-pull 一致）。
function Invoke-NativeWithTimeout {
  param([string]$FilePath, [string[]]$Arguments, [int]$TimeoutSeconds, [string]$Label)
  $stdoutPath = [System.IO.Path]::GetTempFileName()
  $stderrPath = [System.IO.Path]::GetTempFileName()
  $commandLine = ConvertTo-ArgumentString -Arguments $Arguments
  try {
    $process = Start-Process -FilePath $FilePath -ArgumentList $commandLine -PassThru -NoNewWindow `
      -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
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
    return [pscustomobject]@{ ExitCode = $exitCode; Output = (@($stdoutText, $stderrText) -join "`n").Trim() }
  } finally {
    Remove-Item -Force $stdoutPath, $stderrPath -ErrorAction SilentlyContinue
  }
}

# 解析 node 输出里的最后一行 JSON（允许前面有日志行）。
function ConvertFrom-JsonText {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
  $lines = @($Text -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\{.*\}$' })
  if ($lines.Count -eq 0) { return $null }
  try { return ($lines[$lines.Count - 1] | ConvertFrom-Json) } catch { return $null }
}

function Invoke-PiSsh {
  param([string]$Command, [int]$Attempts = 3, [int]$TimeoutSeconds = 60)
  $arguments = @(
    "-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2",
    $target, $Command
  )
  $last = $null
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    $result = Invoke-NativeWithTimeout -FilePath "ssh.exe" -Arguments $arguments -TimeoutSeconds $TimeoutSeconds -Label "ssh: $Command"
    if ($result.ExitCode -eq 0) { return $result.Output }
    $last = $result
    if ($attempt -lt $Attempts) { Start-Sleep -Seconds 5 }
  }
  throw "ssh 失败（exit=$($last.ExitCode)）：$($last.Output)"
}

# 状态写回 Pi：ASCII 化 + 0644，应用只读；远端临时文件名随机。
function Write-PiStatus {
  param([object]$Status)
  $json = ($Status | ConvertTo-Json -Compress -Depth 5)
  [System.IO.File]::WriteAllText($statusTmp, $json, (New-Object System.Text.UTF8Encoding($false)))
  $remoteTmp = "/tmp/antifieldcloud-offsite-{0}.json" -f ([guid]::NewGuid().ToString("N").Substring(0, 12))
  $scpArguments = @("-o", "BatchMode=yes", "-o", "ConnectTimeout=10", $statusTmp, "$target`:$remoteTmp")
  $scpResult = Invoke-NativeWithTimeout -FilePath "scp.exe" -Arguments $scpArguments -TimeoutSeconds 60 -Label "scp offsite status"
  if ($scpResult.ExitCode -ne 0) { throw "scp 状态上传失败（exit=$($scpResult.ExitCode)）" }
  Invoke-PiSsh "sudo install -o antifieldcloud -g antifieldcloud -m 0644 '$remoteTmp' '$StatusPath'" | Out-Null
  Invoke-PiSsh "sudo rm -f '$remoteTmp'" | Out-Null
}

# 兜底状态：node 未运行/输出异常/超时也写 ok=false，避免 Dashboard 显示“很久没跑”而不是失败。
function New-FailureStatus {
  param([string]$ErrorMessage)
  # 状态会写回 Pi（0644、应用只读展示）：错误文本去掉绝对路径/凭据样式（OPS-14/OPS-20）。
  $sanitized = $ErrorMessage
  if (-not [string]::IsNullOrWhiteSpace($sanitized)) {
    $sanitized = $sanitized -replace '[A-Za-z]:\\[^\s"''<>|]+', '<path>'
    $sanitized = $sanitized -replace '/(?:var|home|etc|opt|tmp|run|srv|root|mnt|media|Users)/[^\s"''<>|]+', '<path>'
    $sanitized = $sanitized -replace '(?i)(password|token|secret)=[^\s&]+', '$1=<redacted>'
  }
  return [pscustomobject]@{
    lastRunAt        = (Get-Date).ToUniversalTime().ToString("o")
    ok               = $false
    remoteLabel      = $RemoteLabel
    uploaded         = 0
    skipped          = 0
    failed           = 1
    bytes            = 0
    keptRemote       = 0
    plaintextSkipped = 0
    error            = $sanitized
  }
}

$offsiteStatus = $null
$exitCode = 1
try {
  if ([string]::IsNullOrWhiteSpace($Remote)) {
    Write-Log "未配置 -Remote（rclone 远端），跳过异地副本；写入 ok=false 状态便于发现配置缺失"
    $offsiteStatus = New-FailureStatus "offsite_not_configured"
    $exitCode = 2
  } elseif (-not (Test-Path -LiteralPath $NodeScriptPath)) {
    throw "缺少 backup-offsite.mjs：$NodeScriptPath"
  } elseif (-not (Test-Path -LiteralPath $BackupRoot)) {
    throw "备份目录不存在：$BackupRoot"
  } else {
    $effectiveLabel = if ([string]::IsNullOrWhiteSpace($RemoteLabel)) { "offsite" } else { $RemoteLabel }
    $nodeArguments = @(
      $NodeScriptPath,
      "--backup-root", $BackupRoot,
      "--remote", $Remote,
      "--remote-label", $effectiveLabel,
      "--keep-days", [string]$KeepDays,
      "--max-delete", [string]$MaxDelete,
      "--rclone-bin", $RcloneBin,
      "--json-out", $statusTmp
    )
    if (-not [string]::IsNullOrWhiteSpace($RemotePath)) { $nodeArguments += @("--remote-path", $RemotePath) }
    if ($DryRun) { $nodeArguments += "--dry-run" }
    Write-Log ("开始异地副本：remoteLabel={0} keepDays={1} maxDelete={2} dryRun={3}" -f $RemoteLabel, $KeepDays, $MaxDelete, [bool]$DryRun)
    $nodeResult = Invoke-NativeWithTimeout -FilePath $NodeExe -Arguments $nodeArguments -TimeoutSeconds $CommandTimeoutSec -Label "backup-offsite.mjs"
    $offsiteStatus = ConvertFrom-JsonText -Text $nodeResult.Output
    if (-not $offsiteStatus) {
      $offsiteStatus = New-FailureStatus ("node 输出无法解析（exit=" + $nodeResult.ExitCode + "）")
    }
    $exitCode = $nodeResult.ExitCode
    if ($exitCode -ne 0 -and $offsiteStatus.ok -eq $true) { $offsiteStatus.ok = $false }
    Write-Log ("异地副本完成：uploaded={0} skipped={1} failed={2} bytes={3} keptRemote={4} plaintextSkipped={5} ok={6}" -f `
      $offsiteStatus.uploaded, $offsiteStatus.skipped, $offsiteStatus.failed, $offsiteStatus.bytes, $offsiteStatus.keptRemote, $offsiteStatus.plaintextSkipped, $offsiteStatus.ok)
  }
} catch {
  Write-Log "异地副本失败：$($_.Exception.Message)"
  $offsiteStatus = New-FailureStatus $_.Exception.Message
  $exitCode = 1
} finally {
  if ($offsiteStatus) {
    if (-not $NoStatusWrite) {
      try {
        Write-PiStatus $offsiteStatus
        Write-Log "状态已写回：$StatusPath"
      } catch {
        Write-Log "错误：状态写回失败（不影响本次退出码）：$($_.Exception.Message)"
      }
    }
    Remove-Item -LiteralPath $statusTmp -Force -ErrorAction SilentlyContinue
  }
}

if ($exitCode -ne 0) { exit $exitCode }
exit 0

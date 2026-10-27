param(
  [string]$BackupRoot = (Join-Path $env:USERPROFILE "AntifieldCloudBackups"),
  [switch]$IncludeWorld,
  [switch]$RequireWorld,
  [int]$KeepDays = 180,
  [int]$ExpectedSchemaVersion = 0,
  [string]$NodeExe = "node",
  [string]$AgeIdentityPath = "",
  [string]$AgeExe = "age",
  [int]$CommandTimeoutSec = 300,
  [int]$WorldExtractTimeoutSec = 3600,
  [string]$PiHost = "",
  [string]$PiUser = "antifield",
  [string]$RemoteStatusPath = "/var/lib/antifieldcloud/drill-status.json",
  [switch]$SkipRemoteStatus
)

# 恢复演练（只读）：用 PC 上已拉取的真实归档验证「全量 + 增量」链可解包、可校验、可打开。
# 1) 定位最新 full 与其后的全部 inc（按归档名时间戳排序；明文 .tar.gz 与加密 .tar.gz.age 混合链均支持）；
# 2) 每个归档校验 .sha256 旁文件 + SHA-256（加密归档先校验密文，再用 -AgeIdentityPath 解密到临时目录，
#    按 <archive>.meta.json 的 plainSha256/plainSize 校验明文，临时明文随演练目录清理）；
# 3) 链连续性：inc 的 manifest.since 必须与上一归档 createdAt 对齐（缺失/断链即失败）；
# 4) 解包到临时目录（先完成安全检查才解包），取最新 db-*.sqlite，调用 node drill-verify.mjs
#    做 PRAGMA integrity_check / foreign_key_check / schema_version 与 manifest schema/mode/fileCount 校验；
# 5) 世界归档默认只校验 SHA/列表/level.dat（-IncludeWorld 时才解包，且先检查临时盘空间）；
# 6) 输出 %BackupRoot%\drills\<UTC>\report.json|report.md，失败退出码 1；
# 7) 可选把 ASCII 状态写回 Pi /var/lib/antifieldcloud/drill-status.json（-PiHost 指定时）。
# 约束：绝不修改/删除归档；只删除 drills 下超过 KeepDays 的历史报告。私钥路径/明文内容不写日志与状态。
# 所有外部命令都有硬超时；无 -AgeIdentityPath 且链中存在加密归档时明确失败（不跳过、不误判通过）。
$ErrorActionPreference = "Stop"
# 远端/本地 JSON 统一 UTF-8；PS 5.1 默认 GBK 解码会导致中文 JSON 解析失败（OP-06）。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$script:errors = New-Object System.Collections.Generic.List[object]
$script:warnings = New-Object System.Collections.Generic.List[object]
$script:startedAt = Get-Date
$script:tempDir = $null
$script:report = $null

$base = Join-Path $env:LOCALAPPDATA "AntifieldCloud"
$logPath = Join-Path $base "drill.log"
$reportRoot = Join-Path $BackupRoot "drills"
$worldRoot = Join-Path $BackupRoot "world"
$drillVerifyPath = Join-Path $PSScriptRoot "drill-verify.mjs"
$target = "$PiUser@$PiHost"

# 期望 schema 默认来自 deploy/tool-versions.json（由 check-version 与 server/src/db.ts 交叉校验），
# 避免 drill 文档/脚本各自维护一份 schema 常量。
if ($ExpectedSchemaVersion -le 0) {
  $toolVersionsPath = Join-Path (Split-Path -Parent $PSScriptRoot) "deploy/tool-versions.json"
  if (Test-Path -LiteralPath $toolVersionsPath) {
    try {
      $toolVersions = ([System.IO.File]::ReadAllText($toolVersionsPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json)
      $ExpectedSchemaVersion = [int]$toolVersions.schemaVersion
    } catch {
      Write-Warning "无法解析 $toolVersionsPath，schema 校验将跳过：$($_.Exception.Message)"
    }
  }
}
$script:ageCommand = $null
if (-not [string]::IsNullOrWhiteSpace($AgeIdentityPath)) {
  if (-not (Test-Path -LiteralPath $AgeIdentityPath)) { throw "age 私钥文件不存在：$AgeIdentityPath" }
  $script:ageCommand = Get-Command $AgeExe -ErrorAction SilentlyContinue
  if (-not $script:ageCommand) { throw "找不到 age（-AgeIdentityPath 需要 $AgeExe 在 PATH 中）" }
}

New-Item -ItemType Directory -Force -Path $base, $reportRoot | Out-Null

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

# 状态/错误只保留 ASCII，避免 PowerShell 5.1 跨编码解析 JSON 失败（OP-06/OP-08）。
function ConvertTo-AsciiText {
  param([string]$Text)
  if ($null -eq $Text) { return $null }
  $builder = New-Object System.Text.StringBuilder
  foreach ($char in $Text.ToCharArray()) {
    $code = [int]$char
    if ($code -ge 32 -and $code -lt 127) { [void]$builder.Append($char) } else { [void]$builder.Append('?') }
  }
  return $builder.ToString()
}

function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

function Add-DrillError {
  param([string]$Code, [string]$Message)
  # report.json/远端状态只写 ASCII code+message（OP-06）；detail 保留中文仅供本地 report.md/日志。
  $script:errors.Add([pscustomobject]@{
    code    = (ConvertTo-AsciiText -Text $Code)
    message = (ConvertTo-AsciiText -Text $Message)
    detail  = $Message
  })
  Write-Log "错误 [$Code]：$Message"
}

function Add-DrillWarning {
  param([string]$Code, [string]$Message)
  $script:warnings.Add([pscustomobject]@{
    code    = (ConvertTo-AsciiText -Text $Code)
    message = (ConvertTo-AsciiText -Text $Message)
    detail  = $Message
  })
  Write-Log "警告 [$Code]：$Message"
}

function New-DrillException {
  param([string]$Code, [string]$Message)
  $exception = New-Object System.Exception($Message)
  $exception.Data["code"] = $Code
  return $exception
}

function Get-ExceptionCode {
  param([System.Management.Automation.ErrorRecord]$ErrorRecord)
  if ($ErrorRecord -and $null -ne $ErrorRecord.Exception.Data -and $ErrorRecord.Exception.Data.Contains("code")) {
    return [string]$ErrorRecord.Exception.Data["code"]
  }
  return "drill_failed"
}

# 把参数数组拼成 Windows 命令行字符串（PS 5.1 的 Start-Process 只接受字符串）。
function ConvertTo-ArgumentString {
  param([string[]]$Arguments)
  $quoted = foreach ($argument in $Arguments) {
    if ($argument -match '[\s"]') { '"' + ($argument -replace '"', '\"') + '"' } else { $argument }
  }
  return ($quoted -join " ")
}

# 执行本地进程并硬超时：超时用 taskkill /T /F 杀整棵进程树（OP-18）。
function Invoke-NativeWithTimeout {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [int]$TimeoutSeconds,
    [string]$Label
  )
  $stdoutPath = [System.IO.Path]::GetTempFileName()
  $stderrPath = [System.IO.Path]::GetTempFileName()
  $commandLine = ConvertTo-ArgumentString -Arguments $Arguments
  try {
    $process = Start-Process -FilePath $FilePath -ArgumentList $commandLine -PassThru -NoNewWindow `
      -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    # PS 5.1：Start-Process -PassThru 必须缓存 Handle 后 WaitForExit，ExitCode 才有值。
    $null = $process.Handle
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      try {
        & taskkill.exe /T /F /PID $process.Id 2>&1 | Out-Null
      } catch {
        try { $process.Kill() } catch { }
      }
      throw (New-DrillException -Code "command_timeout" -Message "命令超时（${TimeoutSeconds}s，已杀进程树）：$Label")
    }
    $stdoutRaw = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw -Encoding UTF8 -ErrorAction SilentlyContinue } else { $null }
    $stderrRaw = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw -Encoding UTF8 -ErrorAction SilentlyContinue } else { $null }
    # Get-Content -Raw 对空文件返回 AutomationNull，[string] 转换后仍不是普通空串，需显式归一化。
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

# 解析 node 输出的 JSON（取最后一行 { ... }）。
function ConvertFrom-JsonText {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
  $lines = @($Text -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\{.*\}$' })
  if ($lines.Count -eq 0) { return $null }
  try { return ($lines[$lines.Count - 1] | ConvertFrom-Json) } catch { return $null }
}

# 调用 drill-verify.mjs：返回解析后的 JSON；退出码 0/1 都解析（1 表示校验失败）。
function Invoke-Verify {
  param([string[]]$Arguments, [int]$TimeoutSeconds = $CommandTimeoutSec, [string]$Label = "drill-verify")
  $allArguments = @($drillVerifyPath) + $Arguments
  $result = Invoke-NativeWithTimeout -FilePath $script:nodeBin -Arguments $allArguments -TimeoutSeconds $TimeoutSeconds -Label $Label
  if ($result.ExitCode -ne 0 -and $result.ExitCode -ne 1) {
    Add-DrillError -Code "drill_verify_failed" -Message ("drill-verify.mjs 退出码 $($result.ExitCode)：$($result.StdErr)")
    return $null
  }
  $json = ConvertFrom-JsonText -Text $result.StdOut
  if (-not $json) {
    Add-DrillError -Code "drill_verify_output_invalid" -Message ("无法解析 drill-verify 输出：" + $result.StdOut)
    return $null
  }
  return $json
}

function Add-VerifyResult {
  param([object]$Result, [string]$Context)
  if (-not $Result) { return }
  if ($Result.ok -ne $true) {
    foreach ($item in @($Result.errors)) {
      if ($item) { Add-DrillError -Code ([string]$item.code) -Message ("$Context：" + [string]$item.message) }
    }
  }
}

# 归档名解析：snapshot-<YYYYMMDDTHHMMSS[fff]Z>[-序号]-(full|inc).tar.gz[.age]
function Get-ArchiveDescriptor {
  param([System.IO.FileInfo]$File)
  $match = [regex]::Match($File.Name, '^snapshot-(\d{8}T\d{6,9}Z)(?:-\d+)?-(full|inc)\.tar\.gz(\.age)?$')
  if (-not $match.Success) { return $null }
  $stamp = $match.Groups[1].Value
  $mode = $match.Groups[2].Value
  $encrypted = $match.Groups[3].Success
  $timestamp = ConvertFrom-Stamp -Stamp $stamp
  if ($null -eq $timestamp) {
    Add-DrillWarning -Code "archive_name_unexpected" -Message ("忽略无法解析时间戳的归档名：$($File.Name)")
    return $null
  }
  return [pscustomobject]@{
    Name      = $File.Name
    FullName  = $File.FullName
    Stamp     = $stamp
    Mode      = $mode
    Encrypted = $encrypted
    Timestamp = $timestamp
    SizeBytes = $File.Length
    # WorkPath/WorkName 指向“可用于 tar 校验的明文文件”；加密归档在 Test-Archive 解密后填充。
    WorkPath  = $File.FullName
    WorkName  = $File.Name
    PlainSha256 = $null
    PlainSizeBytes = $null
  }
}

function ConvertFrom-Stamp {
  param([string]$Stamp)
  # 归档时间戳为 yyyyMMddTHHmmss[1-3 位小数秒]Z；兼容旧 CLI 的 6 位与 9 位，也避免 7/8 位被静默忽略。
  $match = [regex]::Match($Stamp, '^(\d{8})T(\d{6})(\d{1,3})?Z$')
  if (-not $match.Success) { return $null }
  $styles = [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal
  try {
    $value = [datetime]::ParseExact($match.Groups[1].Value + $match.Groups[2].Value, "yyyyMMddHHmmss", [System.Globalization.CultureInfo]::InvariantCulture, $styles)
    if ($match.Groups[3].Success) {
      $fraction = $match.Groups[3].Value.PadRight(3, '0')
      $value = $value.AddMilliseconds([int]$fraction)
    }
    return $value
  } catch {
    return $null
  }
}

function Get-TimestampFromDatabaseName {
  param([string]$Name)
  $match = [regex]::Match($Name, '^db-(\d{8}T\d{6,9}Z)(?:-\d+)?\.sqlite$')
  if (-not $match.Success) { return $null }
  return (ConvertFrom-Stamp -Stamp $match.Groups[1].Value)
}

# 按文件体积给压缩/解压操作留超时：小归档用基础值，大世界归档按 MiB 估算并夹在 7200s 内。
function Get-SizeBasedTimeout {
  param([long]$SizeBytes, [int]$BaseSeconds, [double]$SecondsPerMiB)
  $sizeMB = [Math]::Max(1, [Math]::Ceiling($SizeBytes / [double]1MB))
  return [int][Math]::Min(7200, [Math]::Max($BaseSeconds, [int]($sizeMB * $SecondsPerMiB)))
}

# 生成 tar 列表并做条目类型检查；返回列表文件路径（供 drill-verify 复核路径安全性）。
function Get-ArchiveListing {
  param([object]$Archive)
  $timeout = Get-SizeBasedTimeout -SizeBytes $Archive.SizeBytes -BaseSeconds $CommandTimeoutSec -SecondsPerMiB 8
  $nameResult = Invoke-NativeWithTimeout -FilePath $script:tarBin -Arguments @('-tzf', $Archive.WorkPath) -TimeoutSeconds $timeout -Label "tar -tzf $($Archive.Name)"
  if ($nameResult.ExitCode -ne 0) {
    Add-DrillError -Code "tar_list_failed" -Message ("tar -tzf 失败（exit=$($nameResult.ExitCode)）：$($Archive.Name) $($nameResult.StdErr)")
    return $null
  }
  $verboseResult = Invoke-NativeWithTimeout -FilePath $script:tarBin -Arguments @('-tvzf', $Archive.WorkPath) -TimeoutSeconds $timeout -Label "tar -tvzf $($Archive.Name)"
  if ($verboseResult.ExitCode -ne 0) {
    Add-DrillError -Code "tar_list_failed" -Message ("tar -tvzf 失败（exit=$($verboseResult.ExitCode)）：$($Archive.Name) $($verboseResult.StdErr)")
    return $null
  }
  $entries = @($nameResult.StdOut -split "`r?`n" | Where-Object { $_ -ne "" })
  $verboseLines = @($verboseResult.StdOut -split "`r?`n" | Where-Object { $_ -ne "" })
  foreach ($line in $verboseLines) {
    if ($line.Length -eq 0) { continue }
    $typeChar = $line.Substring(0, 1)
    if ($typeChar -ne '-' -and $typeChar -ne 'd') {
      Add-DrillError -Code "tar_entry_type_unsafe" -Message ("归档含符号链接/硬链接/设备等不允许条目（type=$typeChar）：$($Archive.Name)")
      break
    }
  }
  if ($entries.Count -eq 0) {
    Add-DrillError -Code "tar_list_empty" -Message ("归档条目为空：$($Archive.Name)")
    return $null
  }
  $listingPath = Join-Path $script:tempDir ("listing-" + $Archive.Name + ".txt")
  Write-Utf8NoBom -Path $listingPath -Content (($entries -join "`n") + "`n")
  return [pscustomobject]@{ Path = $listingPath; Entries = $entries }
}

# 从归档中只解出 manifest（安全检查通过后才调用），返回本地路径。
function Expand-ArchiveManifest {
  param([object]$Archive)
  $probeDir = Join-Path $script:tempDir ("probe-" + $Archive.Stamp + "-" + $Archive.Mode)
  New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
  $member = "backups/manifest-$($Archive.Stamp).json"
  $timeout = Get-SizeBasedTimeout -SizeBytes $Archive.SizeBytes -BaseSeconds $CommandTimeoutSec -SecondsPerMiB 8
  $result = Invoke-NativeWithTimeout -FilePath $script:tarBin -Arguments @('-xzf', $Archive.WorkPath, '-C', $probeDir, $member) -TimeoutSeconds $timeout -Label "tar manifest $($Archive.Name)"
  $manifestPath = Join-Path (Join-Path $probeDir 'backups') ("manifest-" + $Archive.Stamp + ".json")
  if ($result.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $manifestPath)) {
    Add-DrillError -Code "manifest_missing" -Message ("归档缺少可解析的 manifest（$member）：$($Archive.Name) $($result.StdErr)")
    return $null
  }
  return $manifestPath
}

# 读取加密归档外部 sidecar（<name>.meta.json）：plainSha256/plainSize/encryptedWith。
# 缺失/字段非法即失败（D-08；加密归档不能靠“能解密”当唯一校验）。
function Read-EncryptionMeta {
  param([object]$Archive)
  $metaPath = "$($Archive.FullName).meta.json"
  if (-not (Test-Path -LiteralPath $metaPath)) {
    Add-DrillError -Code "encrypted_meta_missing" -Message ("加密归档缺少 .meta.json：$($Archive.Name)")
    return $null
  }
  try {
    $meta = ([System.IO.File]::ReadAllText($metaPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json)
  } catch {
    Add-DrillError -Code "encrypted_meta_invalid" -Message ("加密归档 .meta.json 不是合法 JSON：$($Archive.Name)")
    return $null
  }
  if (([string]$meta.plainSha256) -notmatch '^[0-9a-fA-F]{64}$' -or [long]$meta.plainSize -lt 0) {
    Add-DrillError -Code "encrypted_meta_invalid" -Message ("加密归档 .meta.json 缺 plainSha256/plainSize：$($Archive.Name)")
    return $null
  }
  if (([string]$meta.cipherSha256) -notmatch '^[0-9a-fA-F]{64}$' -or [long]$meta.cipherSize -le 0) {
    Add-DrillError -Code "encrypted_meta_invalid" -Message ("加密归档 .meta.json 缺 cipherSha256/cipherSize：$($Archive.Name)")
    return $null
  }
  if ([int]$meta.schema -ne 2 -or [string]$meta.name -ne $Archive.Name -or [string]$meta.archiveFormat -ne "tar.gz.age" -or $meta.encrypted -ne $true) {
    Add-DrillError -Code "encrypted_meta_invalid" -Message ("加密归档 .meta.json 的 schema/name/archiveFormat/encrypted 不匹配：$($Archive.Name)")
    return $null
  }
  if ([string]$meta.encryptedWith -ne "age" -or ([string]$meta.recipient) -notmatch '^age1[0-9a-z]{16,}$') {
    Add-DrillError -Code "encrypted_meta_invalid" -Message ("加密归档 .meta.json encryptedWith/recipient 非法：$($Archive.Name)")
    return $null
  }
  return $meta
}

# 用离线私钥把 .age 解密到演练临时目录；校验 plainSha256/plainSize 后返回明文路径。
function Expand-EncryptedArchive {
  param([object]$Archive)
  if (-not $script:ageCommand) {
    Add-DrillError -Code "encrypted_requires_identity" -Message ("链中存在加密归档，但未提供 -AgeIdentityPath：$($Archive.Name)")
    return $null
  }
  $meta = Read-EncryptionMeta -Archive $Archive
  if (-not $meta) { return $null }
  $plainDir = Join-Path $script:tempDir "plain"
  New-Item -ItemType Directory -Force -Path $plainDir | Out-Null
  $plainName = $Archive.Name -replace '\.age$', ''
  $plainPath = Join-Path $plainDir $plainName
  $timeout = Get-SizeBasedTimeout -SizeBytes $Archive.SizeBytes -BaseSeconds ($CommandTimeoutSec * 2) -SecondsPerMiB 30
  $result = Invoke-NativeWithTimeout -FilePath $script:ageCommand.Source -Arguments @(
    '-d', '-i', $AgeIdentityPath, '-o', $plainPath, $Archive.FullName
  ) -TimeoutSeconds $timeout -Label "age -d $($Archive.Name)"
  if ($result.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $plainPath)) {
    Add-DrillError -Code "encrypted_decrypt_failed" -Message ("age 解密失败（exit=$($result.ExitCode)）：$($Archive.Name) $($result.StdErr)")
    return $null
  }
  $plainSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $plainPath).Hash.ToLower()
  $plainSize = (Get-Item -LiteralPath $plainPath).Length
  if ($plainSha -ne ([string]$meta.plainSha256).ToLower() -or $plainSize -ne [long]$meta.plainSize) {
    Add-DrillError -Code "encrypted_plain_mismatch" -Message ("解密后明文与 .meta.json 的 plainSha256/plainSize 不一致：$($Archive.Name)")
    return $null
  }
  return [pscustomobject]@{ Path = $plainPath; Name = $plainName; Meta = $meta; PlainSha256 = $plainSha; PlainSizeBytes = $plainSize }
}

# 校验单个归档：sidecar/SHA/tar 列表/manifest（含 mode/fileCount 比对）。
# 加密归档先校验密文 SHA，再解密校验 plainSha/plainSize，然后复用同一套 tar/manifest 校验。
function Test-Archive {
  param([object]$Archive)
  $sidecarPath = "$($Archive.FullName).sha256"
  if (-not (Test-Path -LiteralPath $sidecarPath)) {
    Add-DrillError -Code "sidecar_missing" -Message ("缺少 .sha256 旁文件：$($Archive.Name)")
    return $null
  }
  $verifySidecar = $sidecarPath
  $verifyName = $Archive.Name
  if ($Archive.Encrypted) {
    $meta = Read-EncryptionMeta -Archive $Archive
    if (-not $meta) { return $null }
    # 密文 SHA/大小与 sidecar 的 cipherSha256/cipherSize 交叉校验（防止 .sha256 与 .meta.json 不一致）。
    $cipherSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $Archive.FullName).Hash.ToLower()
    $cipherSize = (Get-Item -LiteralPath $Archive.FullName).Length
    if ($cipherSha -ne ([string]$meta.cipherSha256).ToLower() -or $cipherSize -ne [long]$meta.cipherSize) {
      Add-DrillError -Code "encrypted_cipher_mismatch" -Message ("密文 SHA/大小与 .meta.json 不一致：$($Archive.Name)")
      return $null
    }
    $cipherVerify = Invoke-Verify -Arguments @(
      '--archive', $Archive.FullName,
      '--sidecar', $sidecarPath,
      '--expect-archive-name', $Archive.Name
    ) -Label "verify ciphertext $($Archive.Name)"
    Add-VerifyResult -Result $cipherVerify -Context $Archive.Name
    if (-not $cipherVerify -or $cipherVerify.ok -ne $true) { return $null }
    $expanded = Expand-EncryptedArchive -Archive $Archive
    if (-not $expanded) { return $null }
    $Archive.WorkPath = $expanded.Path
    $Archive.WorkName = $expanded.Name
    $Archive.PlainSha256 = $expanded.PlainSha256
    $Archive.PlainSizeBytes = $expanded.PlainSizeBytes
    $verifySidecar = "$($expanded.Path).sha256"
    Write-Utf8NoBom -Path $verifySidecar -Content ("{0}  {1}`n" -f $expanded.PlainSha256, $expanded.Name)
    $verifyName = $expanded.Name
  }
  $listing = Get-ArchiveListing -Archive $Archive
  if (-not $listing) { return $null }
  $manifestPath = Expand-ArchiveManifest -Archive $Archive
  if (-not $manifestPath) { return $null }
  $arguments = @(
    '--archive', $Archive.WorkPath,
    '--sidecar', $verifySidecar,
    '--expect-archive-name', $verifyName,
    '--tar-list', $listing.Path,
    '--manifest', $manifestPath,
    '--expect-mode', $Archive.Mode
  )
  $verify = Invoke-Verify -Arguments $arguments -Label "verify $($Archive.Name)"
  Add-VerifyResult -Result $verify -Context $Archive.Name
  $sha256 = $null
  if ($verify -and $verify.checks -and $verify.checks.sidecar) { $sha256 = $verify.checks.sidecar.sha256 }
  return [pscustomobject]@{
    Archive        = $Archive
    Sha256         = $sha256
    CipherSha256   = if ($Archive.Encrypted) { $sha256 } else { $null }
    PlainSha256    = $Archive.PlainSha256
    Encrypted      = [bool]$Archive.Encrypted
    Entries        = $listing.Entries.Count
    FileCount      = if ($verify -and $verify.checks -and $verify.checks.tar) { $verify.checks.tar.fileEntries } else { $null }
    Manifest       = if ($verify -and $verify.checks -and $verify.checks.manifest) { $verify.checks.manifest.details } else { $null }
  }
}

function Get-ChainArchives {
  $searchRoots = @()
  foreach ($candidate in @((Join-Path $BackupRoot "weekly"), (Join-Path $BackupRoot "daily"))) {
    if (Test-Path -LiteralPath $candidate) { $searchRoots += $candidate }
  }
  if ($searchRoots.Count -eq 0) {
    Add-DrillError -Code "chain_missing" -Message ("未找到 daily/weekly 备份目录：$BackupRoot")
    return @()
  }
  $archives = @()
  foreach ($searchRoot in $searchRoots) {
    $files = @(Get-ChildItem -LiteralPath $searchRoot -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '\.tar\.gz(\.age)?$' })
    foreach ($file in $files) {
      $descriptor = Get-ArchiveDescriptor -File $file
      if ($descriptor) { $archives += $descriptor }
    }
  }
  return $archives
}

function Get-SelectedChain {
  param([object[]]$Archives)
  $fullArchives = @($Archives | Where-Object { $_.Mode -eq "full" } | Sort-Object Timestamp -Descending)
  if ($fullArchives.Count -eq 0) {
    Add-DrillError -Code "chain_missing" -Message "没有可用的全量归档（snapshot-*-full.tar.gz）"
    return $null
  }
  $full = $fullArchives[0]
  $increments = @($Archives | Where-Object { $_.Mode -eq "inc" -and $_.Timestamp -gt $full.Timestamp } | Sort-Object Timestamp)
  return [pscustomobject]@{ Full = $full; Increments = $increments }
}

function Invoke-ChainExtraction {
  param([object]$Chain)
  $extractDir = Join-Path $script:tempDir "restore"
  New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
  $chainArchives = @($Chain.Full) + @($Chain.Increments)
  foreach ($archive in $chainArchives) {
    $timeout = Get-SizeBasedTimeout -SizeBytes $archive.SizeBytes -BaseSeconds $CommandTimeoutSec -SecondsPerMiB 15
    $result = Invoke-NativeWithTimeout -FilePath $script:tarBin -Arguments @('-xzf', $archive.WorkPath, '-C', $extractDir) -TimeoutSeconds $timeout -Label "tar -xzf $($archive.Name)"
    if ($result.ExitCode -ne 0) {
      Add-DrillError -Code "tar_extract_failed" -Message ("解包失败（exit=$($result.ExitCode)）：$($archive.Name) $($result.StdErr)")
      return $null
    }
  }
  return $extractDir
}

function Get-LatestDatabase {
  param([string]$ExtractDir)
  $backupsDir = Join-Path $ExtractDir "backups"
  if (-not (Test-Path -LiteralPath $backupsDir)) {
    Add-DrillError -Code "db_snapshot_missing" -Message "解包目录中缺少 backups/ 目录"
    return $null
  }
  $dbFiles = @(Get-ChildItem -LiteralPath $backupsDir -File -Filter "db-*.sqlite" -ErrorAction SilentlyContinue)
  if ($dbFiles.Count -eq 0) {
    Add-DrillError -Code "db_snapshot_missing" -Message "解包目录中找不到 db-*.sqlite"
    return $null
  }
  $best = $null
  $bestTimestamp = $null
  foreach ($file in $dbFiles) {
    $timestamp = Get-TimestampFromDatabaseName -Name $file.Name
    if ($null -eq $timestamp) {
      Add-DrillWarning -Code "db_name_unexpected" -Message "忽略无法解析时间的 DB 快照：$($file.Name)"
      continue
    }
    if ($null -eq $bestTimestamp -or $timestamp -gt $bestTimestamp) {
      $best = $file
      $bestTimestamp = $timestamp
    }
  }
  if (-not $best) {
    Add-DrillError -Code "db_snapshot_missing" -Message "没有时间戳可解析的 db-*.sqlite"
    return $null
  }
  return [pscustomobject]@{ File = $best; Timestamp = $bestTimestamp }
}

# 世界归档：默认只校验 SHA/条目安全/level.dat；-IncludeWorld 时先查空间再解包。
function Test-WorldArchive {
  $result = [ordered]@{
    present          = $false
    archive          = $null
    sizeBytes        = 0
    sha256Verified   = $false
    entries          = 0
    hasLevelDat      = $false
    extracted        = $false
    restoredLevelDat = $false
  }
  if (-not (Test-Path -LiteralPath $worldRoot)) {
    if ($RequireWorld) {
      Add-DrillError -Code "world_archive_missing" -Message ("未找到世界备份目录：$worldRoot")
    } else {
      Add-DrillWarning -Code "world_archive_missing" -Message ("未找到世界备份目录（世界备份功能可能尚未启用）：$worldRoot")
    }
    return $result
  }
  $worldArchives = @(
    Get-ChildItem -LiteralPath $worldRoot -File -Filter "world-*.tar.gz" -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^world-\d{8}T\d{6}Z\.tar\.gz$' } |
      Sort-Object Name -Descending
  )
  if ($worldArchives.Count -eq 0) {
    if ($RequireWorld) {
      Add-DrillError -Code "world_archive_missing" -Message ("世界备份目录中没有 world-<UTC>.tar.gz：$worldRoot")
    } else {
      Add-DrillWarning -Code "world_archive_missing" -Message ("世界备份目录中没有可校验归档：$worldRoot")
    }
    return $result
  }
  $latest = $worldArchives[0]
  $result.present = $true
  $result.archive = $latest.Name
  $result.sizeBytes = $latest.Length
  Write-Log "校验世界归档：$($latest.Name)（$($latest.Length) bytes）"
  $sidecarPath = "$($latest.FullName).sha256"
  $listing = $null
  $tempWorldDir = Join-Path $script:tempDir "world-check"
  New-Item -ItemType Directory -Force -Path $tempWorldDir | Out-Null
  $timeout = Get-SizeBasedTimeout -SizeBytes $latest.Length -BaseSeconds $CommandTimeoutSec -SecondsPerMiB 8
  $nameResult = Invoke-NativeWithTimeout -FilePath $script:tarBin -Arguments @('-tzf', $latest.FullName) -TimeoutSeconds $timeout -Label "tar -tzf world"
  if ($nameResult.ExitCode -eq 0) {
    $entries = @($nameResult.StdOut -split "`r?`n" | Where-Object { $_ -ne "" })
    $listingPath = Join-Path $tempWorldDir "world-listing.txt"
    Write-Utf8NoBom -Path $listingPath -Content (($entries -join "`n") + "`n")
    $listing = [pscustomobject]@{ Path = $listingPath; Entries = $entries }
  } else {
    Add-DrillError -Code "tar_list_failed" -Message ("世界归档 tar -tzf 失败（exit=$($nameResult.ExitCode)）：$($latest.Name) $($nameResult.StdErr)")
    return $result
  }
  if (Test-Path -LiteralPath $sidecarPath) {
    $arguments = @(
      '--archive', $latest.FullName,
      '--sidecar', $sidecarPath,
      '--expect-archive-name', $latest.Name,
      '--tar-list', $listing.Path,
      '--world-tar'
    )
    $verify = Invoke-Verify -Arguments $arguments -TimeoutSeconds (Get-SizeBasedTimeout -SizeBytes $latest.Length -BaseSeconds $CommandTimeoutSec -SecondsPerMiB 8) -Label "verify world $($latest.Name)"
    Add-VerifyResult -Result $verify -Context "world"
    if ($verify -and $verify.ok -eq $true) {
      $result.sha256Verified = $true
      $result.entries = $listing.Entries.Count
      if ($verify.checks -and $verify.checks.tar) { $result.hasLevelDat = [bool]$verify.checks.tar.hasLevelDat }
    }
  } else {
    Add-DrillError -Code "sidecar_missing" -Message ("世界归档缺少 .sha256 旁文件：$($latest.Name)")
  }
  if (-not $IncludeWorld) {
    return $result
  }
  if (-not $result.hasLevelDat) {
    Add-DrillError -Code "world_level_dat_missing" -Message ("世界归档缺少 world/level.dat，无法解包验证：$($latest.Name)")
    return $result
  }
  # 解包前检查临时盘空间：需要 ≥ 归档体积 3 倍。
  $requiredBytes = [long]($latest.Length * 3)
  $tempRootPath = [System.IO.Path]::GetPathRoot($script:tempDir)
  $availableBytes = [long]0
  try {
    $drive = New-Object System.IO.DriveInfo($tempRootPath)
    $availableBytes = [long]$drive.AvailableFreeSpace
  } catch {
    Add-DrillWarning -Code "world_space_unknown" -Message ("无法读取临时盘可用空间：$($_.Exception.Message)")
    $availableBytes = -1
  }
  if ($availableBytes -ge 0 -and $availableBytes -lt $requiredBytes) {
    Add-DrillError -Code "world_extract_no_space" -Message ("临时盘空间不足：需要 ≥ $([Math]::Round($requiredBytes / 1GB, 1)) GiB，可用 $([Math]::Round($availableBytes / 1GB, 1)) GiB")
    return $result
  }
  $worldExtractDir = Join-Path $script:tempDir "world-extract"
  New-Item -ItemType Directory -Force -Path $worldExtractDir | Out-Null
  $extractTimeout = Get-SizeBasedTimeout -SizeBytes $latest.Length -BaseSeconds $WorldExtractTimeoutSec -SecondsPerMiB 30
  $extract = Invoke-NativeWithTimeout -FilePath $script:tarBin -Arguments @('-xzf', $latest.FullName, '-C', $worldExtractDir) -TimeoutSeconds $extractTimeout -Label "tar -xzf world"
  if ($extract.ExitCode -ne 0) {
    Add-DrillError -Code "world_extract_failed" -Message ("世界归档解包失败（exit=$($extract.ExitCode)）$($extract.StdErr)")
    return $result
  }
  $result.extracted = $true
  $levelDat = Join-Path (Join-Path $worldExtractDir 'world') 'level.dat'
  if (Test-Path -LiteralPath $levelDat) {
    $result.restoredLevelDat = $true
    Write-Log "世界归档解包成功：world/level.dat $((Get-Item -LiteralPath $levelDat).Length) bytes"
  } else {
    Add-DrillError -Code "world_level_dat_missing" -Message "世界归档解包后缺少 world/level.dat"
  }
  Remove-Item -Recurse -Force -LiteralPath $worldExtractDir -ErrorAction SilentlyContinue
  return $result
}

function Invoke-DrillReportRetention {
  $cutoff = (Get-Date).ToUniversalTime().AddDays(-$KeepDays)
  $directories = @(Get-ChildItem -LiteralPath $reportRoot -Directory -ErrorAction SilentlyContinue)
  $removed = 0
  foreach ($directory in $directories) {
    if ($directory.Name -notmatch '^\d{8}T\d{6}Z$') { continue }
    $timestamp = ConvertFrom-Stamp -Stamp $directory.Name
    if ($null -eq $timestamp) { continue }
    if ($timestamp -lt $cutoff) {
      try {
        Remove-Item -Recurse -Force -LiteralPath $directory.FullName
        $removed += 1
        Write-Log "清理过期演练报告：$($directory.Name)"
      } catch {
        Add-DrillWarning -Code "drill_report_cleanup_failed" -Message ("清理过期演练报告失败（$($directory.Name)）：$($_.Exception.Message)")
      }
    }
  }
  return $removed
}

# 把 ASCII 状态写回 Pi（可选）：scp → sudo install 0644。
function Write-RemoteDrillStatus {
  param([object]$Report)
  if ($SkipRemoteStatus -or $PiHost -eq "") {
    Write-Log "跳过远端演练状态写入（未指定 -PiHost 或 -SkipRemoteStatus）"
    return
  }
  $statusTmp = Join-Path $env:TEMP ("antifieldcloud-drill-status-" + [guid]::NewGuid().ToString("N") + ".json")
  $errorCodes = @($script:errors | ForEach-Object { $_.code })
  $warningCodes = @($script:warnings | ForEach-Object { $_.code })
  $firstError = $null
  if ($errorCodes.Count -gt 0) { $firstError = $errorCodes[0] }
  $firstMessage = $null
  if ($script:errors.Count -gt 0) {
    # 远端状态不写本地绝对路径/私钥路径（状态文件 0644，应用只读展示）；报告内保留完整信息。
    $firstMessage = $script:errors[0].message
    $firstMessage = $firstMessage -replace '[A-Za-z]:\\[^\s"''<>|]+', '<path>'
    $firstMessage = $firstMessage -replace '/(?:var|home|etc|opt|tmp|run|srv|root|mnt|media|Users)/[^\s"''<>|]+', '<path>'
  }
  $status = [ordered]@{
    lastRunAt     = (Get-Date).ToUniversalTime().ToString("o")
    ok            = $Report.ok
    report        = $Report.report.name
    fullArchive   = $Report.full.archive
    incCount      = @($Report.increments).Count
    latestDb      = $Report.database.name
    schemaVersion = $Report.database.schemaVersion
    worldArchive  = $Report.world.archive
    worldChecked  = $Report.world.sha256Verified
    error         = $firstError
    message       = $firstMessage
    errors        = @($errorCodes)
    warnings      = @($warningCodes)
  }
  $statusJson = ConvertTo-Json -InputObject $status -Compress -Depth 5
  Write-Utf8NoBom -Path $statusTmp -Content $statusJson
  try {
    $remoteTemp = "/tmp/antifieldcloud-drill-status.json"
    $upload = Invoke-NativeWithTimeout -FilePath "scp.exe" -Arguments @("-o", "BatchMode=yes", "-o", "ConnectTimeout=10", $statusTmp, "${target}:$remoteTemp") -TimeoutSeconds 60 -Label "scp upload: drill-status"
    if ($upload.ExitCode -ne 0) {
      throw (New-DrillException -Code "remote_status_write_failed" -Message "演练状态上传失败（exit=$($upload.ExitCode)）")
    }
    $install = Invoke-NativeWithTimeout -FilePath "ssh.exe" -Arguments @("-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", $target, "sudo install -o root -g root -m 0644 '$remoteTemp' '$RemoteStatusPath' && rm -f '$remoteTemp'") -TimeoutSeconds 60 -Label "ssh install: drill-status"
    if ($install.ExitCode -ne 0) {
      throw (New-DrillException -Code "remote_status_write_failed" -Message "演练状态安装失败（exit=$($install.ExitCode)）：$($install.StdErr)")
    }
    Write-Log "已写入远端演练状态：$RemoteStatusPath"
  } catch {
    Add-DrillWarning -Code (Get-ExceptionCode -ErrorRecord $_) -Message ("远端演练状态写入失败：$($_.Exception.Message)")
  } finally {
    Remove-Item -Force -LiteralPath $statusTmp -ErrorAction SilentlyContinue
  }
}

function Build-ReportMarkdown {
  param([object]$Report, [object[]]$RawErrors = @(), [object[]]$RawWarnings = @())
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("# AntifieldComplexx 恢复演练报告")
  $lines.Add("")
  $lines.Add("- 运行时间（UTC）：$($Report.runAt)")
  $lines.Add("- 结果：$(if ($Report.ok) { '通过' } else { '失败' })")
  $lines.Add("- 备份根目录：$($Report.backupRoot)")
  $lines.Add("- 耗时：$($Report.durationMs) ms")
  $lines.Add("")
  $lines.Add("## 归档链")
  $lines.Add("")
  $lines.Add("| 类型 | 归档 | 大小（bytes） | SHA-256 校验 | 条目数 |")
  $lines.Add("|---|---|---|---|---|")
  $lines.Add("| full | $($Report.full.archive) | $($Report.full.sizeBytes) | $($Report.full.sha256Verified) | $($Report.full.entries) |")
  foreach ($increment in @($Report.increments)) {
    $lines.Add("| inc | $($increment.archive) | $($increment.sizeBytes) | $($increment.sha256Verified) | $($increment.entries) |")
  }
  $lines.Add("")
  $lines.Add("## 数据库校验")
  $lines.Add("")
  $lines.Add("- 最新 DB 快照：$($Report.database.name)")
  $lines.Add("- schema_version：$($Report.database.schemaVersion)")
  $lines.Add("- integrity_check：$($Report.database.integrity)")
  $lines.Add("- foreign_key_check：通过=$($Report.database.foreignKeyOk)，违规=$($Report.database.foreignKeyViolations)")
  $lines.Add("")
  $lines.Add("## 世界归档")
  $lines.Add("")
  if ($Report.world.present) {
    $lines.Add("- 归档：$($Report.world.archive)")
    $lines.Add("- SHA-256 校验：$($Report.world.sha256Verified)")
    $lines.Add("- level.dat：$($Report.world.hasLevelDat)")
    $lines.Add("- 已解包：$($Report.world.extracted)")
  } else {
    $lines.Add("- 未找到世界归档（世界备份功能可能尚未启用）")
  }
  $lines.Add("")
  $lines.Add("## 错误与警告")
  $lines.Add("")
  # report.json 的 message 为 ASCII；report.md 使用原始中文 detail 便于人工阅读。
  if (@($RawErrors).Count -eq 0) { $lines.Add("- 无错误") }
  foreach ($error in @($RawErrors)) {
    $detail = $error.detail
    if (-not $detail) { $detail = $error.message }
    $lines.Add("- 错误 [$($error.code)]：$detail")
  }
  foreach ($warning in @($RawWarnings)) {
    $detail = $warning.detail
    if (-not $detail) { $detail = $warning.message }
    $lines.Add("- 警告 [$($warning.code)]：$detail")
  }
  $lines.Add("")
  return ($lines -join "`r`n")
}

function Write-DrillReport {
  param([object]$Report, [string]$ReportDir)
  $jsonPath = Join-Path $ReportDir "report.json"
  $markdownPath = Join-Path $ReportDir "report.md"
  Write-Utf8NoBom -Path $jsonPath -Content ((ConvertTo-Json -InputObject $Report -Depth 10) + "`n")
  [System.IO.File]::WriteAllText($markdownPath, (Build-ReportMarkdown -Report $Report -RawErrors $script:errors.ToArray() -RawWarnings $script:warnings.ToArray()), (New-Object System.Text.UTF8Encoding($true)))
  Write-Log "演练报告：$jsonPath"
  Write-Log "演练报告：$markdownPath"
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

$script:nodeBin = $null
$script:tarBin = $null
$fullResult = $null
$incrementResults = @()
$databaseResult = $null
$worldResult = $null
$reportDir = $null
$chainVerified = $false

try {
  # 运行环境检查：node / tar / drill-verify.mjs。
  $nodeCommand = Get-Command $NodeExe -ErrorAction SilentlyContinue
  if (-not $nodeCommand) { throw (New-DrillException -Code "node_missing" -Message "找不到 Node（$NodeExe）；需要 Node >= 26 运行 drill-verify.mjs") }
  $script:nodeBin = $nodeCommand.Source
  $tarCommand = Get-Command "tar" -ErrorAction SilentlyContinue
  if (-not $tarCommand) { throw (New-DrillException -Code "tar_missing" -Message "找不到 tar；Windows 10+ 自带 tar.exe") }
  $script:tarBin = $tarCommand.Source
  if (-not (Test-Path -LiteralPath $drillVerifyPath)) {
    throw (New-DrillException -Code "drill_verify_missing" -Message "缺少 drill-verify.mjs：$drillVerifyPath")
  }
  if (-not (Test-Path -LiteralPath $BackupRoot)) {
    throw (New-DrillException -Code "backup_root_missing" -Message "备份目录不存在：$BackupRoot")
  }
  $nodeVersion = Invoke-NativeWithTimeout -FilePath $script:nodeBin -Arguments @('--version') -TimeoutSeconds 30 -Label "node --version"
  if ($nodeVersion.ExitCode -ne 0) { throw (New-DrillException -Code "node_missing" -Message "node --version 失败：$($nodeVersion.StdErr)") }
  Write-Log "演练开始：BackupRoot=$BackupRoot node=$($nodeVersion.StdOut)"

  $script:tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("antifieldcloud-drill-" + (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ") + "-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $script:tempDir | Out-Null

  $archives = @(Get-ChainArchives)
  if ($archives.Count -eq 0) {
    Add-DrillError -Code "chain_missing" -Message "备份目录中没有 snapshot-*-full/inc.tar.gz"
  } else {
    $selected = Get-SelectedChain -Archives $archives
    if ($selected) {
      Write-Log ("归档链：full=$($selected.Full.Name)，inc=$(@($selected.Increments).Count) 个")
      $fullCheck = Test-Archive -Archive $selected.Full
      $chainChecks = @()
      $chainVerified = $false
      if ($fullCheck) {
        $chainChecks += $fullCheck
        $fullResult = [ordered]@{
          archive       = $fullCheck.Archive.Name
          sizeBytes     = $fullCheck.Archive.SizeBytes
          encrypted     = $fullCheck.Encrypted
          sha256        = $fullCheck.Sha256
          plainSha256   = $fullCheck.PlainSha256
          sha256Verified = ($null -ne $fullCheck.Sha256)
          entries       = $fullCheck.Entries
          manifest      = $fullCheck.Manifest
        }
      }
      foreach ($increment in @($selected.Increments)) {
        $incrementCheck = Test-Archive -Archive $increment
        if ($incrementCheck) {
          $chainChecks += $incrementCheck
          $incrementResults += [ordered]@{
            archive        = $incrementCheck.Archive.Name
            sizeBytes      = $incrementCheck.Archive.SizeBytes
            encrypted      = $incrementCheck.Encrypted
            sha256         = $incrementCheck.Sha256
            plainSha256    = $incrementCheck.PlainSha256
            sha256Verified = ($null -ne $incrementCheck.Sha256)
            entries        = $incrementCheck.Entries
          }
        }
      }
      # 链连续性（OPS-13）：每个 inc 的 manifest.since 必须等于/晚于上一归档 createdAt，
      # 缺失 inc 或时间戳倒退都会在这里暴露，不能只靠“单归档 tar 能解开”。
      if ($script:errors.Count -eq 0 -and $chainChecks.Count -eq (@($selected.Increments).Count + 1)) {
        $previousCreatedAt = $null
        if ($chainChecks[0].Manifest) { $previousCreatedAt = [string]$chainChecks[0].Manifest.createdAt }
        $chainVerified = $true
        for ($index = 1; $index -lt $chainChecks.Count; $index++) {
          $current = $chainChecks[$index]
          $since = if ($current.Manifest) { [string]$current.Manifest.since } else { $null }
          $createdAt = if ($current.Manifest) { [string]$current.Manifest.createdAt } else { $null }
          if ([string]::IsNullOrWhiteSpace($since)) {
            Add-DrillError -Code "chain_since_missing" -Message ("inc 归档 manifest 缺少 since，无法验证链连续性：$($current.Archive.Name)")
            $chainVerified = $false
            break
          }
          try {
            $sinceTime = [datetime]::Parse($since, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AdjustToUniversal -bor [System.Globalization.DateTimeStyles]::AssumeUniversal)
            $createdTime = [datetime]::Parse($createdAt, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AdjustToUniversal -bor [System.Globalization.DateTimeStyles]::AssumeUniversal)
            $previousTime = if ($previousCreatedAt) { [datetime]::Parse($previousCreatedAt, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AdjustToUniversal -bor [System.Globalization.DateTimeStyles]::AssumeUniversal) } else { $null }
          } catch {
            Add-DrillError -Code "chain_timestamp_invalid" -Message ("归档 manifest 时间戳无法解析：$($current.Archive.Name)")
            $chainVerified = $false
            break
          }
          if ($previousTime -and $sinceTime -lt $previousTime) {
            Add-DrillError -Code "chain_discontinuity" -Message ("增量链断链/乱序：$($current.Archive.Name) 的 since=$since 早于上一归档 createdAt=$previousCreatedAt")
            $chainVerified = $false
            break
          }
          if ($createdTime -lt $sinceTime) {
            Add-DrillError -Code "chain_timestamp_invalid" -Message ("归档 createdAt 早于 since：$($current.Archive.Name)")
            $chainVerified = $false
            break
          }
          $previousCreatedAt = $createdAt
        }
        if ($chainVerified) { Write-Log ("链连续性通过：full + $((@($selected.Increments).Count)) 个 inc") }
      }
      if ($script:errors.Count -eq 0) {
        $extractDir = Invoke-ChainExtraction -Chain $selected
        if ($extractDir) {
          $latestDb = Get-LatestDatabase -ExtractDir $extractDir
          if ($latestDb) {
            $dbArguments = @('--db', $latestDb.File.FullName)
            if ($ExpectedSchemaVersion -gt 0) { $dbArguments += @('--schema-version', [string]$ExpectedSchemaVersion) }
            $dbVerify = Invoke-Verify -Arguments $dbArguments -Label "verify db $($latestDb.File.Name)"
            Add-VerifyResult -Result $dbVerify -Context "db"
            $integrity = $null
            $foreignKeyOk = $null
            $foreignKeyViolations = $null
            $schemaVersion = $null
            if ($dbVerify -and $dbVerify.checks -and $dbVerify.checks.db) {
              $dbDetails = $dbVerify.checks.db.details
              if ($dbDetails) {
                $integrity = (@($dbDetails.integrity) -join '; ')
                $foreignKeyOk = $dbDetails.foreignKeyOk
                $foreignKeyViolations = @($dbDetails.foreignKeyViolations).Count
                $schemaVersion = $dbDetails.schemaVersion
              }
            }
            $databaseResult = [ordered]@{
              name                  = $latestDb.File.Name
              schemaVersion         = $schemaVersion
              integrity             = $integrity
              foreignKeyOk          = $foreignKeyOk
              foreignKeyViolations  = $foreignKeyViolations
            }
          }
        }
      } else {
        Add-DrillWarning -Code "extract_skipped" -Message "归档链校验未通过，跳过解包与 DB 校验"
      }
    }
  }

  $worldResult = Test-WorldArchive
  $removedReports = Invoke-DrillReportRetention
  if ($removedReports -gt 0) { Write-Log "清理过期演练报告 $removedReports 个" }
} catch {
  Add-DrillError -Code (Get-ExceptionCode -ErrorRecord $_) -Message $_.Exception.Message
  Write-Log ("调用栈：" + $_.ScriptStackTrace)
} finally {
  $now = Get-Date
  $reportDirName = $script:startedAt.ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
  $reportDir = Join-Path $reportRoot $reportDirName
  New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
  $fullReport = [ordered]@{
    archive        = if ($fullResult) { $fullResult.archive } else { $null }
    sizeBytes      = if ($fullResult) { $fullResult.sizeBytes } else { 0 }
    encrypted      = if ($fullResult) { $fullResult.encrypted } else { $false }
    sha256         = if ($fullResult) { $fullResult.sha256 } else { $null }
    plainSha256    = if ($fullResult) { $fullResult.plainSha256 } else { $null }
    sha256Verified = if ($fullResult) { $fullResult.sha256Verified } else { $false }
    entries        = if ($fullResult) { $fullResult.entries } else { 0 }
  }
  $databaseReport = [ordered]@{
    name                 = if ($databaseResult) { $databaseResult.name } else { $null }
    schemaVersion        = if ($databaseResult) { $databaseResult.schemaVersion } else { $null }
    integrity            = if ($databaseResult) { $databaseResult.integrity } else { $null }
    foreignKeyOk         = if ($databaseResult) { $databaseResult.foreignKeyOk } else { $null }
    foreignKeyViolations = if ($databaseResult) { $databaseResult.foreignKeyViolations } else { $null }
  }
  $worldReport = [ordered]@{
    present          = if ($worldResult) { $worldResult.present } else { $false }
    archive          = if ($worldResult) { $worldResult.archive } else { $null }
    sizeBytes        = if ($worldResult) { $worldResult.sizeBytes } else { 0 }
    sha256Verified   = if ($worldResult) { $worldResult.sha256Verified } else { $false }
    entries          = if ($worldResult) { $worldResult.entries } else { 0 }
    hasLevelDat      = if ($worldResult) { $worldResult.hasLevelDat } else { $false }
    extracted        = if ($worldResult) { $worldResult.extracted } else { $false }
    restoredLevelDat = if ($worldResult) { $worldResult.restoredLevelDat } else { $false }
  }
  $script:report = [ordered]@{
    runAt         = (Get-Date).ToUniversalTime().ToString("o")
    ok            = ($script:errors.Count -eq 0)
    durationMs    = [long]((Get-Date) - $script:startedAt).TotalMilliseconds
    backupRoot    = $BackupRoot
    includeWorld  = [bool]$IncludeWorld
    chainVerified = [bool]$chainVerified
    full          = $fullReport
    increments    = @($incrementResults)
    database      = $databaseReport
    world         = $worldReport
    report        = [ordered]@{ name = $reportDirName; json = (Join-Path $reportDir "report.json"); markdown = (Join-Path $reportDir "report.md") }
    errors        = [object[]]@($script:errors | ForEach-Object { [pscustomobject]@{ code = $_.code; message = $_.message } })
    warnings      = [object[]]@($script:warnings | ForEach-Object { [pscustomobject]@{ code = $_.code; message = $_.message } })
  }
  Write-DrillReport -Report $script:report -ReportDir $reportDir
  Write-RemoteDrillStatus -Report $script:report
  if ($script:tempDir -and (Test-Path -LiteralPath $script:tempDir)) {
    Remove-Item -Recurse -Force -LiteralPath $script:tempDir -ErrorAction SilentlyContinue
  }
}

if ($script:errors.Count -gt 0) {
  Write-Log ("演练失败：$($script:errors.Count) 个错误，报告 $reportDir")
  exit 1
}
Write-Log "演练通过：报告 $reportDir"
exit 0

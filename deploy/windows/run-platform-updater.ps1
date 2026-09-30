param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [Parameter(Mandatory = $true)][string]$Config
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw "Updater executable not found" }
if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) { throw "Updater configuration not found" }

# IgnoreNew only covers processes started by this scheduled task. A manual
# recovery runner can overlap a scheduler retry, so also lock across runners
# and logon sessions for the same configuration. No credential enters the name.
$resolvedConfig = (Resolve-Path -LiteralPath $Config -ErrorAction Stop).ProviderPath
$canonicalConfig = [IO.Path]::GetFullPath($resolvedConfig).ToUpperInvariant()
$hasher = [Security.Cryptography.SHA256]::Create()
try {
  $configHash = -join ($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonicalConfig)) | ForEach-Object { $_.ToString("x2") })
} finally { $hasher.Dispose() }
$mutex = New-Object Threading.Mutex($false, "Global\RemiPlatformUpdater-$configHash")
$ownsMutex = $false
try {
  try { $ownsMutex = $mutex.WaitOne(0) }
  catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
  if (-not $ownsMutex) { exit 0 }

  foreach ($line in Get-Content -LiteralPath $resolvedConfig) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    $separator = $trimmed.IndexOf("=")
    if ($separator -lt 1) { throw "Invalid updater configuration line" }
    $name = $trimmed.Substring(0, $separator).Trim()
    $value = $trimmed.Substring($separator + 1)
    if ($name -notmatch '^[A-Z][A-Z0-9_]*$') { throw "Invalid updater configuration name" }
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
  }

  & $Executable
  exit $LASTEXITCODE
} finally {
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}

param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [Parameter(Mandatory = $true)][string]$Config
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw "Updater executable not found" }
if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) { throw "Updater configuration not found" }

foreach ($line in Get-Content -LiteralPath $Config) {
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

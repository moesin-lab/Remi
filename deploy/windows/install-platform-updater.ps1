param(
  [Parameter(Mandatory = $true)][string]$UpdaterExecutable,
  [Parameter(Mandatory = $true)][string]$Config,
  [string]$InstallDirectory = "$env:ProgramData\Remi\platform-updater",
  [string]$TaskName = "Remi Platform Updater"
)

$ErrorActionPreference = "Stop"
$sourceRunner = Join-Path $PSScriptRoot "run-platform-updater.ps1"
foreach ($path in @($UpdaterExecutable, $Config, $sourceRunner)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required file not found: $path" }
}

$required = @(
  "MULTIREMI_API_URL", "MULTIREMI_TOKEN", "MULTIREMI_PLATFORM_UPDATER_TOKEN",
  "MULTIREMI_PLATFORM_DRIVER", "MULTIREMI_PLATFORM_RELEASE_FEED_URL",
  "MULTIREMI_LOCAL_PROFILE_REPOSITORY", "MULTIREMI_LOCAL_PROFILE_ROOT",
  "MULTIREMI_PLATFORM_NODE"
)
$configured = @{}
foreach ($line in Get-Content -LiteralPath $Config) {
  if ($line -match '^([A-Z][A-Z0-9_]*)=(.*)$') { $configured[$matches[1]] = $matches[2] }
}
foreach ($name in $required) {
  if (-not $configured.ContainsKey($name) -or -not $configured[$name] -or $configured[$name] -like 'replace-*') {
    throw "Missing required updater setting: $name"
  }
}
if ($configured["MULTIREMI_PLATFORM_DRIVER"] -ne "local_profile") { throw "Windows local profile installation requires MULTIREMI_PLATFORM_DRIVER=local_profile" }

New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
$installedExecutable = Join-Path $InstallDirectory "remi-platform-updater.exe"
$installedRunner = Join-Path $InstallDirectory "run-platform-updater.ps1"
$installedConfig = Join-Path $InstallDirectory "platform-updater.env"
Copy-Item -LiteralPath $UpdaterExecutable -Destination $installedExecutable -Force
Copy-Item -LiteralPath $sourceRunner -Destination $installedRunner -Force
Copy-Item -LiteralPath $Config -Destination $installedConfig -Force

$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $InstallDirectory /inheritance:r /grant:r "$identity`:(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to restrict updater directory ACL" }

$arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$installedRunner`" -Executable `"$installedExecutable`" -Config `"$installedConfig`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments -WorkingDirectory $InstallDirectory
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Output "Installed scheduled task '$TaskName' at '$InstallDirectory'."

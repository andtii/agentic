<#
.SYNOPSIS
    Stops and removes the agentic-daemon scheduled task and the supervisor it ran (<root>\supervisor).
    The pairing and the session logs are kept.
#>
[CmdletBinding()]
param(
    [string] $TaskName = 'agentic-daemon',
    [string] $Root = $(if ($env:AGENTIC_INSTALL_DIR) { $env:AGENTIC_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'agentic' })
)

$ErrorActionPreference = 'Stop'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "No scheduled task named '$TaskName'."
} else {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'."
}
$supervisorDir = Join-Path $Root 'supervisor'
if (Test-Path $supervisorDir) {
    Remove-Item -Recurse -Force $supervisorDir
    Write-Host "Removed the supervisor ($supervisorDir)."
}

<#
.SYNOPSIS
    Stops and removes the agentic-daemon scheduled task. The pairing and the session logs are kept.
#>
[CmdletBinding()]
param(
    [string] $TaskName = 'agentic-daemon'
)

$ErrorActionPreference = 'Stop'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "No scheduled task named '$TaskName'."
    return
}
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Removed scheduled task '$TaskName'."

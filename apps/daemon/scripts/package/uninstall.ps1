<#
.SYNOPSIS
    Stops and removes the agentic-daemon background task. The pairing (credentials.json), environments.json
    and the session logs are kept; delete %APPDATA%\agentic and %LOCALAPPDATA%\agentic by hand to remove them,
    and revoke the machine on the Machines page so its token stops working.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File uninstall.ps1
#>
[CmdletBinding()]
param(
    [string] $TaskName = 'agentic-daemon'
)

$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'scripts\uninstall-service.ps1') -TaskName $TaskName
Write-Host "Kept: $(Join-Path $env:APPDATA 'agentic') (pairing, environments) and $(Join-Path $env:LOCALAPPDATA 'agentic') (session logs, daemon.log)."
Write-Host "Revoke the machine on the platform's Machines page if it will not be paired again."

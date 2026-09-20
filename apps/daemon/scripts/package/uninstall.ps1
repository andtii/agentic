<#
.SYNOPSIS
    Stops and removes the agentic-daemon background task. The pairing (credentials.json), environments.json
    and the session logs are kept; delete %APPDATA%\agentic and %LOCALAPPDATA%\agentic by hand to remove them,
    and revoke the machine on the platform (Machine.revoke - README.md > Uninstall) so its token stops working.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File uninstall.ps1
#>
[CmdletBinding()]
param(
    [string] $TaskName = 'agentic-daemon'
)

$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'scripts\uninstall-service.ps1') -TaskName $TaskName

# The `agentic-daemon` command (#354): the launcher and the user PATH entry the install added.
$bin = Join-Path $PSScriptRoot 'bin\agentic-daemon.mjs'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    $portable = Join-Path $env:LOCALAPPDATA 'agentic\node\node.exe'
    if (Test-Path $portable) { $node = Get-Command $portable -ErrorAction SilentlyContinue }
}
if ($node -and (Test-Path $bin)) {
    & $node.Source $bin launcher remove
    if ($LASTEXITCODE -ne 0) { Write-Warning "could not remove the agentic-daemon command; delete $(Join-Path $env:LOCALAPPDATA 'agentic\bin') by hand." }
} else {
    Write-Warning "no Node found, so the agentic-daemon command was left behind; delete $(Join-Path $env:LOCALAPPDATA 'agentic\bin') by hand."
}
Write-Host "Kept: $(Join-Path $env:APPDATA 'agentic') (pairing, environments) and $(Join-Path $env:LOCALAPPDATA 'agentic') (session logs, daemon.log)."
Write-Host "Revoke the machine on the platform (Machine.revoke, see README.md > Uninstall) if it will not be paired again."

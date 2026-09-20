<#
.SYNOPSIS
    Installs agentic-daemon from this folder: checks Node, pairs the machine (optional), runs doctor,
    registers the background task for the current user.

.DESCRIPTION
    Run from the unpacked zip. Nothing is downloaded: the folder holds the daemon and every dependency.
    Node.js 22.12 or newer must be on PATH (https://nodejs.org).

    Pairing needs a code from the platform (Machines > Pair machine). Pass it with -Code and the
    platform URL with -Url, or pair first by hand: node bin\agentic-daemon.mjs pair <code> --url <url>.

    The daemon runs as a per-user Scheduled Task (see scripts\install-service.ps1), not a LocalSystem
    service: the machine token and every Claude Code profile belong to the signed-in user.

    It also writes the `agentic-daemon` command itself (%LOCALAPPDATA%\agentic\bin\agentic-daemon.cmd)
    and adds that folder to the user PATH, so a new terminal can run it.

.PARAMETER Url
    The platform origin, e.g. https://agentic.example. Required with -Code.
.PARAMETER Code
    The pairing code (README.md > "Get a pairing code"). Omit when the machine is already paired.
.PARAMETER Name
    The machine name shown on the platform (default: this computer's name).
.PARAMETER NoService
    Pair and run doctor only; do not register the background task.
.PARAMETER NoPath
    Write the `agentic-daemon` command but leave the user PATH alone.
.PARAMETER TaskName
    The Scheduled Task name (default: agentic-daemon).
.PARAMETER NodePath
    The node.exe to run the daemon with (default: the `node` on PATH). The one-line installer passes the
    portable Node it downloaded when the machine has none.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1 -Url https://agentic.example -Code ABC234
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1     # already paired: doctor + task only
#>
[CmdletBinding()]
param(
    [string] $Url,
    [string] $Code,
    [string] $Name,
    [switch] $NoService,
    [switch] $NoPath,
    [string] $TaskName = 'agentic-daemon',
    [string] $NodePath
)

$ErrorActionPreference = 'Stop'
function Fail($message) { Write-Host $message -ForegroundColor Red; exit 1 }
$here = $PSScriptRoot
$bin = Join-Path $here 'bin\agentic-daemon.mjs'
if (-not (Test-Path $bin)) { Fail "bin\agentic-daemon.mjs not found next to install.ps1 - run this script from the unpacked zip." }

# 1. Node >= 22.12
$node = if ($NodePath) { Get-Command $NodePath -ErrorAction SilentlyContinue } else { Get-Command node -ErrorAction SilentlyContinue }
if (-not $node) { Fail "node is not on PATH. Install Node.js 22.12 or newer from https://nodejs.org and open a new terminal, or run the one-line installer from the platform's Pair page (it downloads Node)." }
$nodeVersion = [Version]((& $node.Source --version).TrimStart('v'))
if ($nodeVersion -lt [Version]'22.12.0') { Fail "Node.js $nodeVersion is too old: agentic-daemon needs 22.12 or newer." }
$daemonVersion = (& $node.Source $bin --version)
Write-Host "$daemonVersion on Node $nodeVersion ($here)"

# 2. The `agentic-daemon` command (#354). First, so it exists even if pairing fails: the launcher runs
# THIS node.exe and THIS folder, so it works on a machine whose only Node is the portable one the
# one-line installer downloaded. Not fatal - the long form below always works.
$launcherArgs = @('launcher', 'install')
if ($NoPath) { $launcherArgs += '--no-profile' }
& $node.Source $bin @launcherArgs
if ($LASTEXITCODE -ne 0) { Write-Warning "could not write the agentic-daemon command; run ``& '$($node.Source)' '$bin'`` instead." }

# 3. Pair (or check the machine is paired)
$home_ = if ($env:AGENTIC_DAEMON_HOME) { $env:AGENTIC_DAEMON_HOME } else { Join-Path $env:APPDATA 'agentic' }
$credentials = Join-Path $home_ 'credentials.json'
if ($Code) {
    if (-not $Url) { Fail "-Code needs -Url <platform origin>." }
    $args_ = @('pair', $Code, '--url', $Url)
    if ($Name) { $args_ += @('--name', $Name) }
    & $node.Source $bin @args_
    if ($LASTEXITCODE -ne 0) { Fail "pairing failed (exit $LASTEXITCODE)." }
} elseif (-not (Test-Path $credentials)) {
    Fail "This machine is not paired ($credentials is missing). Get a code from the platform (Machines > Pair a machine) and run again with -Url <platform> -Code <code>."
} else {
    Write-Host "already paired ($credentials)"
}

# 4. Doctor - environments.json, drivers, profiles. A failing check is reported, not fatal: fix it and re-run doctor.
& $node.Source $bin doctor
if ($LASTEXITCODE -ne 0) {
    Write-Warning "doctor found problems (see above). The daemon still starts; sessions on a failing environment are refused until it passes: node bin\agentic-daemon.mjs doctor"
}

# 5. Background task
if ($NoService) {
    Write-Host "Skipping the background task (-NoService). Run in the foreground with: node bin\agentic-daemon.mjs run"
    return
}
& (Join-Path $here 'scripts\install-service.ps1') -TaskName $TaskName -NodePath $node.Source -DaemonBin $bin
$log = Join-Path $env:LOCALAPPDATA 'agentic\logs\daemon.log'
Write-Host ""
Write-Host "Installed. The machine shows as online on the platform within a minute."
Write-Host "  status:    Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo"
Write-Host "  logs:      Get-Content -Wait `"$log`""
Write-Host "  uninstall: powershell -ExecutionPolicy Bypass -File `"$(Join-Path $here 'uninstall.ps1')`""
Write-Host ""
Write-Host "The ``agentic-daemon`` command is installed. In a NEW terminal:"
Write-Host "  agentic-daemon doctor                       # pairing, environments, sign-ins"
Write-Host "  agentic-daemon policy allow-root <folder>   # let the web add environments inside <folder>"

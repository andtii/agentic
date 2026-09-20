# agentic-daemon one-line installer for Windows. The platform serves this file at /install.ps1;
# the Pair page prints the line to run, with this machine's pairing code:
#
#   $env:AGENTIC_URL='<platform origin>'; $env:AGENTIC_CODE='<code>'; $env:AGENTIC_NAME='<machine name>'; irm <platform origin>/install.ps1 | iex
#
# It needs nothing installed: Node.js 22.12+ on PATH is used when present, otherwise a portable Node
# is downloaded from nodejs.org into the install folder. Then it downloads the daemon zip
# (agentic-daemon-win32-x64.zip from the daemon-latest GitHub release), unpacks it to
# %LOCALAPPDATA%\agentic\daemon and runs the zip's install.ps1: pair (when AGENTIC_CODE is set),
# doctor, and the per-user Scheduled Task that keeps the daemon running.
#
# Re-run without AGENTIC_CODE to upgrade an already paired machine (the task is stopped, the folder
# replaced, the task re-registered). Environment overrides:
#   AGENTIC_DAEMON_ZIP   a local path or URL of the zip to install instead of the release
#   AGENTIC_INSTALL_DIR  the install root (default %LOCALAPPDATA%\agentic)
#   AGENTIC_DAEMON_HOME  where the daemon keeps credentials, environments and sessions (see the README)
#
# Source: apps/web/public/install.ps1 in https://github.com/andtii/agentic (docs/runbook.md section 5).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is many times slower with its progress bar
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$NodeVersion = '22.22.0'
$NodeMinimum = [Version]'22.12.0'
$Release = 'https://github.com/andtii/agentic/releases/download/daemon-latest'
$Asset = 'agentic-daemon-win32-x64.zip'

function Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }
# Never `exit` here: piped through `iex` this runs in the caller's console and exit would close it.
function Fail($message) { throw "agentic install: $message" }

$root = if ($env:AGENTIC_INSTALL_DIR) { $env:AGENTIC_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'agentic' }
$daemonDir = Join-Path $root 'daemon'
$downloads = Join-Path $root 'downloads'
New-Item -ItemType Directory -Force -Path $downloads | Out-Null

if ($env:AGENTIC_CODE -and -not $env:AGENTIC_URL) { Fail 'AGENTIC_CODE needs AGENTIC_URL (the platform origin).' }

# 1. Node >= 22.12: on PATH, already downloaded, or downloaded now.
$nodeExe = $null
$onPath = Get-Command node -ErrorAction SilentlyContinue
if ($onPath) {
    try { if ([Version]((& $onPath.Source --version).TrimStart('v')) -ge $NodeMinimum) { $nodeExe = $onPath.Source } } catch {}
}
$portable = Join-Path $root "node\node.exe"
if (-not $nodeExe -and (Test-Path $portable)) {
    try { if ([Version]((& $portable --version).TrimStart('v')) -ge $NodeMinimum) { $nodeExe = $portable } } catch {}
}
if (-not $nodeExe) {
    Step "downloading Node.js $NodeVersion (no Node $NodeMinimum+ on PATH)"
    $nodeZip = Join-Path $downloads "node-v$NodeVersion-win-x64.zip"
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" -OutFile $nodeZip
    $nodeTmp = Join-Path $root 'node.new'
    if (Test-Path $nodeTmp) { Remove-Item -Recurse -Force $nodeTmp }
    Expand-Archive -Path $nodeZip -DestinationPath $nodeTmp
    $nodeDir = Join-Path $root 'node'
    if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }
    Move-Item (Join-Path $nodeTmp "node-v$NodeVersion-win-x64") $nodeDir
    Remove-Item -Recurse -Force $nodeTmp
    Remove-Item -Force $nodeZip
    $nodeExe = $portable
}
Write-Host "node: $nodeExe ($(& $nodeExe --version))"

# 2. The daemon zip: the release asset, or AGENTIC_DAEMON_ZIP.
$zip = Join-Path $downloads $Asset
if ($env:AGENTIC_DAEMON_ZIP -and -not ($env:AGENTIC_DAEMON_ZIP -match '^https?://')) {
    if (-not (Test-Path $env:AGENTIC_DAEMON_ZIP)) { Fail "AGENTIC_DAEMON_ZIP not found: $env:AGENTIC_DAEMON_ZIP" }
    $zip = (Resolve-Path $env:AGENTIC_DAEMON_ZIP).Path
    Step "installing $zip"
} else {
    $url = if ($env:AGENTIC_DAEMON_ZIP) { $env:AGENTIC_DAEMON_ZIP } else { "$Release/$Asset" }
    Step "downloading $url"
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
}

# 3. Stop a running daemon (its files are about to be replaced), unpack, swap the folder in.
if (Get-ScheduledTask -TaskName agentic-daemon -ErrorAction SilentlyContinue) {
    Step 'stopping the running daemon'
    Stop-ScheduledTask -TaskName agentic-daemon -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}
Step "unpacking to $daemonDir"
$new = Join-Path $root 'daemon.new'
if (Test-Path $new) { Remove-Item -Recurse -Force $new }
Expand-Archive -Path $zip -DestinationPath $new
if (-not (Test-Path (Join-Path $new 'install.ps1'))) { Fail "$zip is not a daemon zip (no install.ps1 at its root)." }
if (Test-Path $daemonDir) {
    try { Remove-Item -Recurse -Force $daemonDir } catch { Fail "cannot replace $daemonDir (is a daemon still running from it?): $_" }
}
Move-Item $new $daemonDir
if ($zip -like "$downloads\*") { Remove-Item -Force $zip }

# 4. The zip's own installer: pair, doctor, scheduled task.
$params = @{ NodePath = $nodeExe }   # a hashtable: an array splat would bind these by position
if ($env:AGENTIC_CODE) { $params.Url = $env:AGENTIC_URL; $params.Code = $env:AGENTIC_CODE }
if ($env:AGENTIC_NAME) { $params.Name = $env:AGENTIC_NAME }
Step 'installing'
& (Join-Path $daemonDir 'install.ps1') @params

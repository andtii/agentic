# agentic-daemon one-line installer for Windows. The platform serves this file at /install.ps1;
# the Pair page prints the line to run, with this machine's pairing code:
#
#   $env:AGENTIC_URL='<platform origin>'; $env:AGENTIC_CODE='<code>'; $env:AGENTIC_NAME='<machine name>'; irm '<platform origin>/install.ps1' | iex
#
# It needs nothing installed: Node.js 22.12+ on PATH is used when present, otherwise a portable Node
# is downloaded from nodejs.org into the install folder. Then it reads the release manifest of the
# channel (or pinned version) asked for, downloads the daemon zip it names for win32-x64
# (agentic-daemon-win32-x64.zip) from that GitHub release, checks its sha256, unpacks it to
# %LOCALAPPDATA%\agentic\daemon and runs the zip's install.ps1: pair (when AGENTIC_CODE is set),
# doctor, the `agentic-daemon` command (on the user PATH) and the per-user Scheduled Task that keeps
# the daemon running.
#
# Re-run without AGENTIC_CODE to upgrade an already paired machine (the task is stopped, the folder
# replaced, the task re-registered). Environment overrides:
#   AGENTIC_CHANNEL      the release channel: latest (the newest main build) or stable (the newest
#                        daemon-v<semver> release); default below
#   AGENTIC_VERSION      a pinned release instead of a channel: daemon-v<semver> (or just <semver>)
#   AGENTIC_DAEMON_ZIP   a local path or URL of the zip to install instead of the release (no manifest,
#                        no sha256 check)
#   AGENTIC_RELEASES     the GitHub releases URL the manifest is read from (default
#                        https://github.com/andtii/agentic/releases): a fork, or a test server
#   AGENTIC_INSTALL_DIR  the install root (default %LOCALAPPDATA%\agentic)
#   AGENTIC_DAEMON_HOME  where the daemon keeps credentials, environments and sessions (see the README)
#   AGENTIC_NO_PATH      set to 1 to write the `agentic-daemon` command without touching your user PATH
#
# Source: apps/web/public/install.ps1 in https://github.com/andtii/agentic (docs/runbook.md section 5).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is many times slower with its progress bar
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

# The channel installed when neither AGENTIC_CHANNEL nor AGENTIC_VERSION is set. 'latest' until the first
# stable daemon release exists, then 'stable'.
$DefaultChannel = 'latest'
$NodeVersion = '22.22.0'
$NodeMinimum = [Version]'22.12.0'
$Releases = if ($env:AGENTIC_RELEASES) { $env:AGENTIC_RELEASES } else { 'https://github.com/andtii/agentic/releases' }
$AssetKey = 'win32-x64'
$Asset = "agentic-daemon-$AssetKey.zip"

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

# 2. The daemon zip: the win32-x64 asset in the release manifest, checked against its sha256 - or AGENTIC_DAEMON_ZIP.
$zip = Join-Path $downloads $Asset
if ($env:AGENTIC_DAEMON_ZIP -and -not ($env:AGENTIC_DAEMON_ZIP -match '^https?://')) {
    if (-not (Test-Path $env:AGENTIC_DAEMON_ZIP)) { Fail "AGENTIC_DAEMON_ZIP not found: $env:AGENTIC_DAEMON_ZIP" }
    $zip = (Resolve-Path $env:AGENTIC_DAEMON_ZIP).Path
    Step "installing $zip"
} elseif ($env:AGENTIC_DAEMON_ZIP) {
    Step "downloading $env:AGENTIC_DAEMON_ZIP"
    Invoke-WebRequest -UseBasicParsing -Uri $env:AGENTIC_DAEMON_ZIP -OutFile $zip
} else {
    if ($env:AGENTIC_VERSION) {
        $tag = 'daemon-v' + ($env:AGENTIC_VERSION -replace '^daemon-v', '')
        $manifestUrl = "$Releases/download/$tag/manifest.json"
    } else {
        $channel = if ($env:AGENTIC_CHANNEL) { $env:AGENTIC_CHANNEL } else { $DefaultChannel }
        $manifestUrl = switch ($channel) {
            'latest' { "$Releases/download/daemon-latest/manifest.json" }
            'stable' { "$Releases/download/daemon-stable/manifest.json" }
            default { Fail "unknown AGENTIC_CHANNEL $channel (latest or stable)" }
        }
    }
    Step "reading $manifestUrl"
    try { $manifest = Invoke-RestMethod -UseBasicParsing -Uri $manifestUrl } catch { Fail "no release manifest at ${manifestUrl}: $_" }
    $entry = if ($manifest.assets) { $manifest.assets.$AssetKey } else { $null }
    if (-not $entry) { Fail "the release at $manifestUrl has no daemon for $AssetKey." }
    $version = if ($entry.version) { $entry.version } else { $manifest.version }
    Step "downloading agentic-daemon ${version}: $($entry.url)"
    Invoke-WebRequest -UseBasicParsing -Uri $entry.url -OutFile $zip
    $expected = ([string]$entry.sha256).ToLowerInvariant()
    # .NET rather than Get-FileHash: that cmdlet is missing when Windows PowerShell inherits a PowerShell 7 module path.
    $stream = [IO.File]::OpenRead($zip)
    try { $actual = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($stream)) -replace '-', '').ToLowerInvariant() } finally { $stream.Dispose() }
    if ($actual -ne $expected) {
        Remove-Item -Force $zip
        Fail "sha256 mismatch for $($entry.url)`n  expected $expected (the release manifest)`n  actual   $actual (the download)"
    }
    Write-Host "sha256: $actual (matches the manifest)"
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
if ($env:AGENTIC_NO_PATH) { $params.NoPath = $true }
Step 'installing'
& (Join-Path $daemonDir 'install.ps1') @params

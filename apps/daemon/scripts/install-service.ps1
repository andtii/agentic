<#
.SYNOPSIS
    Runs agentic-daemon in the background for the current user: at logon, under the supervisor that
    restarts it whenever it exits.

.DESCRIPTION
    Registers a per-user Scheduled Task rather than a Windows service. The daemon must run as the
    signed-in user: the machine token lives under that user's %APPDATA%, and each environment's
    CLAUDE_CONFIG_DIR belongs to that user's profile (a LocalSystem service would see neither).
    Pair the machine first: `agentic-daemon pair <code> --url <platform>`.

    The task runs the supervisor (scripts\supervise.mjs, copied to <root>\supervisor so an update of
    <root>\daemon never replaces it), which runs the daemon and relaunches it after any exit with a
    backoff, applies a staged update and rolls it back when it does not come up. Task Scheduler's own
    restart settings only cover a failed launch, not a process that exits later (#353).
    Re-running this on a machine installed before the supervisor replaces its task action.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install-service.ps1
#>
[CmdletBinding()]
param(
    [string] $TaskName = 'agentic-daemon',
    [string] $NodePath = (Get-Command node -ErrorAction Stop).Source,
    [string] $DaemonBin = (Join-Path $PSScriptRoot '..\bin\agentic-daemon.mjs'),
    # The install root: <root>\daemon, <root>\supervisor, <root>\state (apps/daemon/src/paths.ts installPaths).
    [string] $Root = $(if ($env:AGENTIC_INSTALL_DIR) { $env:AGENTIC_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'agentic' })
)

$ErrorActionPreference = 'Stop'

$bin = (Resolve-Path $DaemonBin).Path
$home_ = if ($env:AGENTIC_DAEMON_HOME) { $env:AGENTIC_DAEMON_HOME } else { Join-Path $env:APPDATA 'agentic' }
$credentials = Join-Path $home_ 'credentials.json'
if (-not (Test-Path $credentials)) {
    throw "This machine is not paired ($credentials is missing). Run: agentic-daemon pair <code> --url <platform>"
}

# Upgrade: a task by this name may be running an older copy (or the pre-supervisor action) - stop it so the new one starts.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 20 -and (Get-ScheduledTask -TaskName $TaskName).State -eq 'Running'; $i++) { Start-Sleep -Milliseconds 500 }
}

$logDir = Join-Path $env:LOCALAPPDATA 'agentic\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'daemon.log'

# The supervisor lives outside the daemon folder: a swap of <root>\daemon never replaces the process doing it.
$root_ = [System.IO.Path]::GetFullPath($Root)
$supervisorDir = Join-Path $root_ 'supervisor'
New-Item -ItemType Directory -Force -Path $supervisorDir | Out-Null
$supervise = Join-Path $supervisorDir 'supervise.mjs'
Copy-Item -Force (Join-Path $PSScriptRoot 'supervise.mjs') $supervise

# The daemon folder is <root>\daemon when the one-line installer put it there; any other folder is named.
$daemonDir = Split-Path -Parent (Split-Path -Parent $bin)
$arguments = "`"$supervise`" --root `"$root_`" --log `"$log`""
if ($daemonDir.TrimEnd('\') -ne (Join-Path $root_ 'daemon')) { $arguments += " --daemon `"$daemonDir`"" }

$action = New-ScheduledTaskAction -Execute $NodePath -Argument $arguments -WorkingDirectory $root_
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "agentic-daemon registered as scheduled task '$TaskName' (supervised) and started. Log: $log; supervisor: $(Join-Path $root_ 'state\supervisor.log')"

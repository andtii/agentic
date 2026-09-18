<#
.SYNOPSIS
    Runs agentic-daemon in the background for the current user: at logon, restarted when it exits.

.DESCRIPTION
    Registers a per-user Scheduled Task rather than a Windows service. The daemon must run as the
    signed-in user: the machine token lives under that user's %APPDATA%, and each environment's
    CLAUDE_CONFIG_DIR belongs to that user's profile (a LocalSystem service would see neither).
    Pair the machine first: `agentic-daemon pair <code> --url <platform>`.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install-service.ps1
#>
[CmdletBinding()]
param(
    [string] $TaskName = 'agentic-daemon',
    [string] $NodePath = (Get-Command node -ErrorAction Stop).Source,
    [string] $DaemonBin = (Join-Path $PSScriptRoot '..\bin\agentic-daemon.mjs')
)

$ErrorActionPreference = 'Stop'

$bin = (Resolve-Path $DaemonBin).Path
$home_ = if ($env:AGENTIC_DAEMON_HOME) { $env:AGENTIC_DAEMON_HOME } else { Join-Path $env:APPDATA 'agentic' }
$credentials = Join-Path $home_ 'credentials.json'
if (-not (Test-Path $credentials)) {
    throw "This machine is not paired ($credentials is missing). Run: agentic-daemon pair <code> --url <platform>"
}

# Upgrade: a task by this name may be running an older copy - stop it so the new one starts.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

$logDir = Join-Path $env:LOCALAPPDATA 'agentic\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'daemon.log'

# cmd.exe only redirects the output; node gets the arguments as-is.
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/d /c `"`"$NodePath`" `"$bin`" run >> `"$log`" 2>&1`""
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

Write-Host "agentic-daemon registered as scheduled task '$TaskName' and started. Log: $log"

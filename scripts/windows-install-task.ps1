$ErrorActionPreference = "Stop"
$repo = Resolve-Path "$PSScriptRoot\.."
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$repo\scripts\windows-start-background.ps1`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "Codex Slack Workspace Bridge" -Action $action -Trigger $trigger -Description "Start Slack bridge for local Codex control" -RunLevel Highest -Force
Write-Host "Registered scheduled task: Codex Slack Workspace Bridge"

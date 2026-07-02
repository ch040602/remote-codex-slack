$ErrorActionPreference = "Stop"
$repo = Resolve-Path "$PSScriptRoot\.."
$pidPath = Join-Path $repo "data\bridge.pid"
$logPath = Join-Path $repo "data\bridge.log"

if (-not (Test-Path $pidPath)) {
  Write-Host "Bridge is not running: no PID file."
  Write-Host "Log: $logPath"
  exit 0
}

$pidValue = [int](Get-Content $pidPath | Select-Object -First 1)
$process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
if ($process) {
  Write-Host "Bridge is running. PID: $pidValue"
} else {
  Write-Host "Bridge is not running, but PID file exists: $pidValue"
}
Write-Host "Log: $logPath"


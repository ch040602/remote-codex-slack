$ErrorActionPreference = "Stop"
$repo = Resolve-Path "$PSScriptRoot\.."
$dataDir = Join-Path $repo "data"
$pidPath = Join-Path $dataDir "bridge.pid"
$logPath = Join-Path $dataDir "bridge.log"
$worker = Join-Path $repo "scripts\windows-run-background-worker.ps1"

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

if (Test-Path $pidPath) {
  $oldPid = (Get-Content $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($oldPid -and (Get-Process -Id ([int]$oldPid) -ErrorAction SilentlyContinue)) {
    Write-Host "Bridge is already running. PID: $oldPid"
    Write-Host "Log: $logPath"
    exit 0
  }
}

$proc = Start-Process -FilePath "powershell.exe" `
  -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$worker`"" `
  -WorkingDirectory $repo `
  -WindowStyle Hidden `
  -PassThru

$proc.Id | Set-Content -Path $pidPath -Encoding ascii
Write-Host "Bridge started in the background. PID: $($proc.Id)"
Write-Host "Log: $logPath"


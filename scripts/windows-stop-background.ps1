$ErrorActionPreference = "Stop"
$repo = Resolve-Path "$PSScriptRoot\.."
$pidPath = Join-Path $repo "data\bridge.pid"

if (-not (Test-Path $pidPath)) {
  Write-Host "Bridge is not running: no PID file."
  exit 0
}

$rootPid = [int](Get-Content $pidPath | Select-Object -First 1)

function Stop-ProcessTree([int]$ProcessId) {
  $children = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $ProcessId }
  foreach ($child in $children) {
    Stop-ProcessTree -ProcessId ([int]$child.ProcessId)
  }
  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($process) {
    Stop-Process -Id $ProcessId -Force
  }
}

Stop-ProcessTree -ProcessId $rootPid
Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
Write-Host "Bridge stopped."


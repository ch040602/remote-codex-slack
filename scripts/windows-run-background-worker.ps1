$ErrorActionPreference = "Stop"
$repo = Resolve-Path "$PSScriptRoot\.."
Set-Location $repo

$dataDir = Join-Path $repo "data"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$logPath = Join-Path $dataDir "bridge.log"
$pidPath = Join-Path $dataDir "bridge.pid"

$PID | Set-Content -Path $pidPath -Encoding ascii

if (-not (Test-Path ".env")) {
  "Missing .env. Copy .env.example to .env and fill Slack tokens before starting." | Tee-Object -FilePath $logPath -Append
  exit 1
}
if (-not (Test-Path "config\projects.yaml")) {
  Copy-Item "config\projects.example.yaml" "config\projects.yaml"
}
if (-not (Test-Path "config\skills.yaml")) {
  Copy-Item "config\skills.example.yaml" "config\skills.yaml"
}
if (-not (Test-Path "node_modules")) {
  npm install *>> $logPath
}

"[$(Get-Date -Format o)] Starting Codex Slack Workspace Bridge" | Tee-Object -FilePath $logPath -Append
npm run dev *>> $logPath


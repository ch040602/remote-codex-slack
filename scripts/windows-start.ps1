$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..
if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
  Write-Host "Created .env. Edit it before starting."
  exit 1
}
if (-not (Test-Path config\projects.yaml)) {
  Copy-Item config\projects.example.yaml config\projects.yaml
}
if (-not (Test-Path config\skills.yaml)) {
  Copy-Item config\skills.example.yaml config\skills.yaml
}
npm install
npm run dev

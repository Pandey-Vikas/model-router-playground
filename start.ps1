# RouteLab launcher — double-click or right-click "Run with PowerShell"
# Usage:
#   .\start.ps1              — start app (runs setup wizard first if no .env)
#   .\start.ps1 -Setup       — force run setup wizard first, even if .env exists
param(
  [switch]$Setup
)
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  RouteLab - Foundry Model Router Playground" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "ERROR: Node.js is not installed or not on PATH." -ForegroundColor Red
  Write-Host "Download Node.js 22 or later from https://nodejs.org/" -ForegroundColor Yellow
  Read-Host "Press Enter to exit"
  exit 1
}

if ($Setup) {
  Write-Host "Forced setup requested. Launching wizard at http://localhost:3100/" -ForegroundColor Yellow
  Write-Host "The main app will NOT auto-start. Re-run '.\start.ps1' (without -Setup) when you're done." -ForegroundColor Yellow
  Write-Host ""
  Start-Sleep -Seconds 2
  Start-Process "http://localhost:3100/"
  node --disable-warning=ExperimentalWarning scripts\setup-server.js
  Write-Host ""
  Write-Host "Wizard exited. Run '.\start.ps1' to start the main app." -ForegroundColor Green
  exit 0
} elseif (-not (Test-Path ".env")) {
  Write-Host "No .env found. Launching setup wizard at http://localhost:3100/" -ForegroundColor Yellow
  Write-Host "Complete the wizard and click Launch — the main app will start automatically after." -ForegroundColor Yellow
  Write-Host ""
  Start-Sleep -Seconds 2
  Start-Process "http://localhost:3100/"
  node --disable-warning=ExperimentalWarning scripts\setup-server.js
  if (-not (Test-Path ".env")) {
    Write-Host "Setup wizard exited without writing .env. Aborting." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
  }
  Write-Host "Setup complete. Starting main app..." -ForegroundColor Green
  Write-Host ""
}

Write-Host "Starting RouteLab on http://localhost:3000/" -ForegroundColor Green
Write-Host "Press Ctrl+C in this window to stop." -ForegroundColor Green
Write-Host ""

# Free port 3000 if something else is already listening (e.g. a previous run left behind)
$existing = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  foreach ($conn in $existing) {
    try {
      $proc = Get-Process -Id $conn.OwningProcess -ErrorAction Stop
      Write-Host "Port 3000 already in use by PID $($proc.Id) ($($proc.ProcessName)). Stopping it..." -ForegroundColor Yellow
      Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
    } catch { }
  }
  Start-Sleep -Milliseconds 800
}

Start-Sleep -Seconds 2
Start-Process "http://localhost:3000/"
node --env-file-if-exists=.env --disable-warning=ExperimentalWarning src\server.js

# RouteLab launcher
# Usage:
#   Right-click this file  ->  "Run with PowerShell"
#   Or from a terminal:    .\start.ps1
#
# If your machine blocks scripts, run once:
#   Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host ""
Write-Host "===== RouteLab launcher =====" -ForegroundColor Cyan
Write-Host ""

# 1. Node.js check
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "Node.js was not found on PATH." -ForegroundColor Red
    Write-Host "Install Node.js 22+ from https://nodejs.org, then rerun this script." -ForegroundColor Yellow
    Read-Host "Press Enter to close"
    exit 1
}
$nodeVersion = (& node --version).Trim()
Write-Host "Node $nodeVersion  ($($node.Source))" -ForegroundColor Gray

# 2. Free port 3000 if a previous run is still holding it
$busy = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($busy) {
    foreach ($conn in $busy) {
        try {
            $p = Get-Process -Id $conn.OwningProcess -ErrorAction Stop
            Write-Host "Port 3000 is held by PID $($p.Id) ($($p.ProcessName)). Stopping it..." -ForegroundColor Yellow
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
        } catch { }
    }
    Start-Sleep -Milliseconds 500
}

# 3. Open the browser once the port is up (in a background job so it doesn't block)
Start-Job -ScriptBlock {
    param($url)
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $ok = Test-NetConnection -ComputerName 'localhost' -Port 3000 -InformationLevel Quiet -WarningAction SilentlyContinue
            if ($ok) { Start-Process $url; return }
        } catch { }
    }
} -ArgumentList 'http://localhost:3000/' | Out-Null

# 4. Start the app in the foreground so Ctrl+C stops it cleanly
Write-Host ""
Write-Host "Starting RouteLab on http://localhost:3000/" -ForegroundColor Green
Write-Host "Press Ctrl+C in this window to stop." -ForegroundColor Green
Write-Host ""
& node --disable-warning=ExperimentalWarning --env-file-if-exists=.env src/server.js

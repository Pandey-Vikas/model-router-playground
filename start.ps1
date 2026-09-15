# RouteLab launcher
# Usage:
#   Right-click this file  ->  "Run with PowerShell"
#   Or from a terminal:    .\start.ps1
#                         .\start.ps1 -Setup   (force the setup wizard even if .env exists)
#
# If your machine blocks scripts, run once:
#   Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned

param(
    [switch]$Setup
)

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

# 2. Free any leftover ports (main app on 3000, setup wizard on 3100)
function Stop-PortOwner([int]$Port) {
    $busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $busy) { return $false }
    $killed = $false
    foreach ($conn in $busy) {
        try {
            $p = Get-Process -Id $conn.OwningProcess -ErrorAction Stop
            Write-Host "Port $Port is held by PID $($p.Id) ($($p.ProcessName)). Stopping it..." -ForegroundColor Yellow
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
            $killed = $true
        } catch { }
    }
    return $killed
}
$anyKilled = $false
$anyKilled = (Stop-PortOwner 3000) -or $anyKilled
$anyKilled = (Stop-PortOwner 3100) -or $anyKilled
if ($anyKilled) { Start-Sleep -Milliseconds 500 }

# 3. Decide: launch the setup wizard, or the main app?
function Test-EnvConfigured {
    $envPath = Join-Path $root '.env'
    if (-not (Test-Path $envPath)) { return $false }
    $lines = Get-Content -LiteralPath $envPath -ErrorAction SilentlyContinue | Where-Object { $_ -and -not $_.StartsWith('#') -and $_.Contains('=') }
    if (-not $lines) { return $false }
    $keys = $lines | ForEach-Object { ($_ -split '=', 2)[0].Trim() }
    return ($keys -contains 'MODEL_PROVIDER')
}

$launchWizard = $Setup -or (-not (Test-EnvConfigured))
if ($launchWizard) {
    if ($Setup) {
        Write-Host "-Setup flag passed. Launching setup wizard..." -ForegroundColor Yellow
    } else {
        Write-Host ".env is missing or empty. Launching setup wizard first..." -ForegroundColor Yellow
        Write-Host "The wizard will collect your Azure details and write .env, then you can rerun .\start.ps1 to launch the app." -ForegroundColor Gray
    }
    Start-Job -ScriptBlock {
        param($url)
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Milliseconds 500
            try {
                $ok = Test-NetConnection -ComputerName 'localhost' -Port 3100 -InformationLevel Quiet -WarningAction SilentlyContinue
                if ($ok) { Start-Process $url; return }
            } catch { }
        }
    } -ArgumentList 'http://localhost:3100/' | Out-Null

    Write-Host ""
    Write-Host "Setup wizard on http://localhost:3100/" -ForegroundColor Green
    Write-Host "Press Ctrl+C in this window to stop." -ForegroundColor Green
    Write-Host ""
    $env:AZURE_LOGIN_EXPERIENCE_V2 = 'off'
    & node --disable-warning=ExperimentalWarning scripts/setup-server.js
    exit 0
}

# 4. Open the browser once the app is up (in a background job so it doesn't block)
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

# 5. Start the app in the foreground so Ctrl+C stops it cleanly
Write-Host ""
Write-Host "Starting RouteLab on http://localhost:3000/" -ForegroundColor Green
Write-Host "Press Ctrl+C in this window to stop." -ForegroundColor Green
Write-Host ""
& node --disable-warning=ExperimentalWarning --env-file-if-exists=.env src/server.js

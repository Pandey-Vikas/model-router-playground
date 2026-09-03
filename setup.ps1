#!/usr/bin/env pwsh
# RouteLab guided setup: launches a browser wizard that signs you into Azure,
# picks a Foundry resource + deployment, writes .env, and starts the app.

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

Write-Host ''
Write-Host 'RouteLab setup wizard' -ForegroundColor Cyan
Write-Host '---------------------'

try {
    $nodeVersion = (& node --version).TrimStart('v')
    $parts = $nodeVersion.Split('.')
    $major = [int]$parts[0]
    $minor = [int]$parts[1]
    if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 5)) {
        throw "Node.js 22.5 or later is required (found $nodeVersion). Install from https://nodejs.org/"
    }
    Write-Host "Node.js $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}

try {
    $null = & az version 2>&1
    if ($LASTEXITCODE -ne 0) { throw }
    Write-Host 'Azure CLI ready' -ForegroundColor Green
} catch {
    Write-Host 'Azure CLI (az) not found. Install from https://aka.ms/installazurecli' -ForegroundColor Red
    exit 1
}

# Prevent az from prompting for an auto-upgrade during wizard calls.
& az config set auto-upgrade.enable=no auto-upgrade.prompt=no --only-show-errors 2>&1 | Out-Null

$port = if ($env:SETUP_PORT) { [int]$env:SETUP_PORT } else { 3100 }
$url = "http://localhost:$port/"

Write-Host ''
Write-Host "Opening wizard at $url" -ForegroundColor Cyan
Write-Host 'Press Ctrl+C in this window to abort.'
Write-Host ''

# Start the wizard server in the background, wait briefly for it to bind, then open the browser.
$server = Start-Process -FilePath 'node' -ArgumentList '--disable-warning=ExperimentalWarning', 'scripts/setup-server.js' -PassThru -NoNewWindow
$deadline = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $deadline) {
    try {
        $null = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
        break
    } catch { Start-Sleep -Milliseconds 200 }
}

Start-Process $url | Out-Null

try {
    Wait-Process -Id $server.Id
} finally {
    if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
}

@echo off
setlocal

cd /d "%~dp0"
echo.
echo Launching RouteLab setup wizard on http://localhost:3100/
echo Complete the wizard to create/edit .env
echo Press Ctrl+C when done.
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js is not installed. Download from https://nodejs.org/
  pause
  exit /b 1
)

timeout /t 2 /nobreak >nul
start "" "http://localhost:3100/"
node --disable-warning=ExperimentalWarning scripts\setup-server.js

@echo off
setlocal

cd /d "%~dp0"
set FORCE_SETUP=0
if /i "%1"=="--setup" set FORCE_SETUP=1
if /i "%1"=="-s" set FORCE_SETUP=1
if /i "%1"=="setup" set FORCE_SETUP=1
if /i "%1"=="/setup" set FORCE_SETUP=1

echo.
echo ============================================================
echo   RouteLab - Foundry Model Router Playground
echo ============================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js is not installed or not on PATH.
  echo Download Node.js 22 or later from https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if "%FORCE_SETUP%"=="1" (
  echo Forced setup requested. Launching wizard...
  echo The main app will NOT auto-start. Re-run start.bat ^(without --setup^) when done.
  echo.
  timeout /t 2 /nobreak >nul
  start "" "http://localhost:3100/"
  node --disable-warning=ExperimentalWarning scripts\setup-server.js
  echo.
  echo Wizard exited. Run start.bat to start the main app.
  exit /b 0
) else if not exist ".env" (
  echo No .env file found. Launching setup wizard first...
  echo A browser tab will open at http://localhost:3100/
  echo Complete the wizard and click Launch. This script will
  echo automatically start the main app when the wizard exits.
  echo.
  timeout /t 2 /nobreak >nul
  start "" "http://localhost:3100/"
  node --disable-warning=ExperimentalWarning scripts\setup-server.js
  echo.
  if not exist ".env" (
    echo Setup wizard exited without writing .env. Aborting.
    pause
    exit /b 1
  )
  echo.
  echo Setup complete. Starting main app...
  echo.
)

echo Starting RouteLab on http://localhost:3000/
echo Press Ctrl+C in this window to stop.
echo.

REM Free port 3000 if something else is already listening
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"LISTENING.*:3000 "') do (
  echo Port 3000 in use by PID %%p. Stopping it...
  taskkill /pid %%p /f >nul 2>&1
)
timeout /t 1 /nobreak >nul

timeout /t 2 /nobreak >nul
start "" "http://localhost:3000/"
node --env-file-if-exists=.env --disable-warning=ExperimentalWarning src\server.js

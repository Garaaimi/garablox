@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [GaraBlox] Node.js not found. Install it from https://nodejs.org and run again.
  pause
  exit /b 1
)

if not exist "node_modules\electron" (
  echo [GaraBlox] First run: installing Electron, this can take a few minutes...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [GaraBlox] npm install failed. Check the output above.
    pause
    exit /b 1
  )
)

call npm start -- %*
if errorlevel 1 (
  echo [GaraBlox] Launcher exited with an error.
  pause
)

endlocal

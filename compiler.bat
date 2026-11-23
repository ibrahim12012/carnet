@echo off
cd /d "%~dp0"
rem Build only: the dependencies must already be there (run build-windows.bat once first)
if not exist node_modules\electron-builder (
  echo Dependencies missing: run build-windows.bat once first.
  pause
  exit /b 1
)
echo Building the installer...
call npm run dist || (pause & exit /b 1)
start "" "%~dp0dist"

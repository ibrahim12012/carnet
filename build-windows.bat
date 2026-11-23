@echo off
cd /d "%~dp0"
where npm >nul 2>nul || (echo Node.js is not installed. Download it from https://nodejs.org & pause & exit /b 1)
echo Installing the dependencies...
call npm install || (pause & exit /b 1)

rem Puts the winCodeSign tool in the cache (avoids the symbolic link error on Windows)
set C=%LOCALAPPDATA%\electron-builder\Cache\winCodeSign
if not exist "%C%\winCodeSign-2.6.0\rcedit-x64.exe" (
  echo Preparing winCodeSign...
  if not exist "%C%" mkdir "%C%"
  curl -sL -o "%C%\wcs.7z" https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z
  node_modules\7zip-bin\win\x64\7za.exe x -y -bso0 -bse0 "%C%\wcs.7z" -o"%C%\winCodeSign-2.6.0"
  del "%C%\wcs.7z" >nul 2>nul
)

echo Building the installer...
call npm run dist || (pause & exit /b 1)
echo.
echo Done. The installer is in the dist folder.
start "" "%~dp0dist"
pause

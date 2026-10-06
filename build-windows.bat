@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 20 or newer is required. & exit /b 1)
where npm >nul 2>nul || (echo npm is required. & exit /b 1)
call npm ci || exit /b 1
call npm run build:win || exit /b 1
call npm run checksum:win || exit /b 1
echo.
echo Windows installer and SHA-256 checksum are in %~dp0release
endlocal

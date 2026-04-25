@echo off
setlocal

cd /d "%~dp0"
set "APP_URL=http://localhost:3000"

if exist ".\dist\le_terroir.exe" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "Start-Process -FilePath '.\dist\le_terroir.exe' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
)

timeout /t 2 /nobreak >nul
start "" "%APP_URL%"

endlocal

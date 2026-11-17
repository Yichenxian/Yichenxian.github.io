@echo off
title Co-op Escape - Local Preview
cd /d "C:\AI\web-game\index"

set PORT=8130
set URL=http://127.0.0.1:%PORT%/escape.html

echo ============================================================
echo   Co-op Escape - Local Preview Server
echo ============================================================
echo.

where py >nul 2>&1
if errorlevel 1 goto TRYPY
set PYCMD=py -3
goto READY

:TRYPY
where python >nul 2>&1
if errorlevel 1 goto NOPY
set PYCMD=python
goto READY

:NOPY
echo [ERROR] Python not found. Install Python and check "Add Python to PATH".
pause
exit /b 1

:READY
echo Python : %PYCMD%
echo URL    : %URL%
echo.
echo Serving folder: C:\AI\web-game\index
echo Starting server. Keep this window open.
echo Browser opens shortly. Close this window to stop.
echo.

start "" /b cmd /c "ping 127.0.0.1 -n 3 >nul & start %URL%"
%PYCMD% -m http.server %PORT% --bind 127.0.0.1
pause

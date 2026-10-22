@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   SDD Studio needs Node.js 18 or newer.
  echo   Install it from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo   SDD Studio
echo   The dashboard opens in your browser when it is ready.
echo   Close this window or press Ctrl+C to stop.
echo.

node "%~dp0bin\sdd.js" studio --open %*
set "code=%ERRORLEVEL%"

if not "%code%"=="0" (
  if "%code%"=="-1073741510" exit /b 0
  if "%code%"=="3221225786" exit /b 0
  echo.
  echo   SDD Studio stopped with exit code %code%.
  echo   If the port is already in use, close the other Studio window and try again.
  echo.
  pause
)

endlocal

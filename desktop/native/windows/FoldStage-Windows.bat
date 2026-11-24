@echo off
setlocal
cd /d "%~dp0\..\..\.."

where node >nul 2>nul
if errorlevel 1 (
  echo [FoldStage] Node.js 18+ is required. Download from https://nodejs.org/
  pause
  exit /b 1
)

if not exist "desktop\native\windows\publish\foldstage-audio-win.exe" (
  where dotnet >nul 2>nul
  if not errorlevel 1 (
    echo [FoldStage] Building Windows audio helper on first run...
    powershell -ExecutionPolicy Bypass -File "desktop\native\windows\build.ps1"
  ) else (
    echo [FoldStage] Note: .NET 8 SDK not found; running without native audio helper (Demo Beat & Open API still work).
  )
)

echo [FoldStage] Launching FoldStage Companion Studio...
node desktop\start.mjs
pause

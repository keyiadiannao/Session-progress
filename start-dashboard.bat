@echo off
title dsh-session-progress dashboard
rem Independent session-task evaluator - separate process, never touches the harness.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [error] Node.js not found in PATH. Install Node >= 22.19.
  pause
  exit /b 1
)

echo Starting dsh-session-progress dashboard ...
echo   Open http://127.0.0.1:3278 in your browser.
echo   Press Ctrl+C to stop.
echo.
node index.mjs "%~dp0config.json"
if errorlevel 1 pause

@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22 or newer and Git for Windows, then run this file again.
  pause
  exit /b 1
)
node scripts\start.mjs
if errorlevel 1 pause

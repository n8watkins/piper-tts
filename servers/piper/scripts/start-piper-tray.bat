@echo off
REM Launches the cross-platform Node tray (tray/piper-tray.js) hidden.
REM Replaces start-piper-tray-windows.bat (the old PowerShell tray).
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t = (Resolve-Path (Join-Path '%~dp0..' 'tray\piper-tray.js')).Path; $n = (Get-Command node -ErrorAction SilentlyContinue).Source; if (-not $n) { $n = 'C:\Program Files\nodejs\node.exe' }; Start-Process -FilePath $n -ArgumentList @($t) -WindowStyle Hidden"

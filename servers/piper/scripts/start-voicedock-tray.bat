@echo off
REM Launches the VoiceDock tray (tray/voicedock-tray.js) hidden.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t = (Resolve-Path (Join-Path '%~dp0..' 'tray\voicedock-tray.js')).Path; $n = (Get-Command node -ErrorAction SilentlyContinue).Source; if (-not $n) { $n = 'C:\Program Files\nodejs\node.exe' }; Start-Process -FilePath $n -ArgumentList @($t) -WindowStyle Hidden"

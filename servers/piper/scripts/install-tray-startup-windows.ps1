$ErrorActionPreference = "Stop"

# Adds the VoiceDock tray to Windows sign-in startup. The tray also manages this
# itself ("Launch at login" in its menu); this script is for setup and scripts.
$Launcher = Join-Path $PSScriptRoot "start-voicedock-tray.vbs"
$StartupDir = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
$ShortcutPath = Join-Path $StartupDir "VoiceDock Tray.lnk"
# The tray was "Piper TTS Tray" up to VoiceDock 1.1.
$LegacyShortcutPath = Join-Path $StartupDir "Piper TTS Tray.lnk"

if (-not (Test-Path $Launcher)) {
  throw "Tray launcher not found: $Launcher"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = Join-Path $env:WINDIR "System32\wscript.exe"
$shortcut.Arguments = "`"$Launcher`""
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.WindowStyle = 7
$shortcut.Description = "Start the VoiceDock tray at Windows sign-in"
$shortcut.Save()

Write-Host "Installed Windows startup shortcut:"
Write-Host $ShortcutPath

if (Test-Path $LegacyShortcutPath) {
  Remove-Item -LiteralPath $LegacyShortcutPath -Force
  Write-Host "Removed the old Piper TTS Tray shortcut:"
  Write-Host $LegacyShortcutPath
}

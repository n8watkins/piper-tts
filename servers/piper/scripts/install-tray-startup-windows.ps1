$ErrorActionPreference = "Stop"

$Launcher = Join-Path $PSScriptRoot "start-piper-tray.bat"
$StartupDir = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
$ShortcutPath = Join-Path $StartupDir "Piper TTS Tray.lnk"

if (-not (Test-Path $Launcher)) {
  throw "Tray launcher not found: $Launcher"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = $Launcher
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.WindowStyle = 7
$shortcut.Description = "Start Piper TTS tray at Windows sign-in"
$shortcut.Save()

Write-Host "Installed Windows startup shortcut:"
Write-Host $ShortcutPath

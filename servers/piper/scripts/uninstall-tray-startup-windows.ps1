$ErrorActionPreference = "Stop"

$StartupDir = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
$ShortcutPath = Join-Path $StartupDir "Piper TTS Tray.lnk"

if (Test-Path $ShortcutPath) {
  Remove-Item -LiteralPath $ShortcutPath -Force
  Write-Host "Removed Windows startup shortcut:"
  Write-Host $ShortcutPath
} else {
  Write-Host "No Piper TTS startup shortcut found."
}

$ErrorActionPreference = "Stop"

$StartupDir = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
# "Piper TTS Tray.lnk" is the shortcut's name from before VoiceDock 1.1.
$removed = $false
foreach ($name in @("VoiceDock Tray.lnk", "Piper TTS Tray.lnk")) {
  $ShortcutPath = Join-Path $StartupDir $name
  if (Test-Path $ShortcutPath) {
    Remove-Item -LiteralPath $ShortcutPath -Force
    Write-Host "Removed Windows startup shortcut:"
    Write-Host $ShortcutPath
    $removed = $true
  }
}
if (-not $removed) {
  Write-Host "No VoiceDock tray startup shortcut found."
}

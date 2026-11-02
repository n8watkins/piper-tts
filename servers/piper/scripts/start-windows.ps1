$ErrorActionPreference = "Stop"

$ServerDir = Split-Path -Parent $PSScriptRoot
Set-Location $ServerDir

if (-not $env:HOST) { $env:HOST = "127.0.0.1" }
if (-not $env:PORT) { $env:PORT = "7477" }
if (-not $env:VOICE_DIR) { $env:VOICE_DIR = Join-Path $ServerDir "piper\voices" }
if (-not $env:OUTPUT_DIR) { $env:OUTPUT_DIR = Join-Path $ServerDir "output" }

if (-not $env:PIPER_BIN) {
  $localPiper = Join-Path $ServerDir "piper\piper.exe"
  if (Test-Path $localPiper) {
    $env:PIPER_BIN = $localPiper
  } else {
    $cmd = Get-Command piper.exe -ErrorAction SilentlyContinue
    if ($cmd) {
      $env:PIPER_BIN = $cmd.Source
    } else {
      $env:PIPER_BIN = $localPiper
    }
  }
}

if (-not (Test-Path $env:PIPER_BIN)) {
  Write-Error "Piper executable was not found: $env:PIPER_BIN. Download Piper and place piper.exe in servers\piper\piper\, or set PIPER_BIN."
}

New-Item -ItemType Directory -Force -Path $env:VOICE_DIR, $env:OUTPUT_DIR | Out-Null

if (-not (Test-Path (Join-Path $ServerDir "node_modules"))) {
  npm install
}

npm start

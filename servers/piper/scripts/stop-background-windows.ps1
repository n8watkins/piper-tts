$ErrorActionPreference = "Stop"

$ServerDir = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $ServerDir "logs"
$LogFile = Join-Path $LogDir "piper-tts-background.log"
$PidFile = Join-Path $LogDir "piper-tts-server.pid"
$WrapperPidFile = Join-Path $LogDir "piper-tts-wrapper.pid"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-ManagedLog {
  param([string]$Message, [string]$Level = "INFO")
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"
  Add-Content -LiteralPath $LogFile -Value "[$timestamp] [$Level] $Message" -Encoding UTF8
}

function Stop-PidFileProcess {
  param([string]$Path, [string]$Label)

  if (-not (Test-Path $Path)) {
    Write-ManagedLog "$Label pid file not found."
    return
  }

  try {
    $processId = [int]((Get-Content -LiteralPath $Path -Raw).Trim())
  } catch {
    Write-ManagedLog "$Label pid file was invalid; removing it." "WARN"
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    return
  }

  $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($proc) {
    Stop-Process -Id $processId -Force
    Write-ManagedLog "Stopped $Label`: pid=$processId"
  } else {
    Write-ManagedLog "$Label was not running: pid=$processId"
  }
  Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
}

Stop-PidFileProcess -Path $PidFile -Label "Piper TTS server"
Start-Sleep -Milliseconds 300
Stop-PidFileProcess -Path $WrapperPidFile -Label "Piper TTS wrapper"

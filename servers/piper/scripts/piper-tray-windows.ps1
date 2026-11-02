$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern bool DestroyIcon(System.IntPtr hIcon);
"@

$ServerDir = Split-Path -Parent $PSScriptRoot
$StartScript = Join-Path $PSScriptRoot "start-background-windows.ps1"
$StopScript = Join-Path $PSScriptRoot "stop-background-windows.ps1"
$LogDir = Join-Path $ServerDir "logs"
$PidFile = Join-Path $LogDir "piper-tts-server.pid"
$IconFile = Join-Path (Split-Path -Parent $ServerDir) "extension\icons\icon128.png"
$HealthUrl = "http://127.0.0.1:7477/health"
$AutoStartServer = $true

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$mutex = New-Object System.Threading.Mutex($false, "Local\PiperTtsSimpleTray")
# WaitOne throws AbandonedMutexException if a previous tray was force-killed
# rather than exiting cleanly — that means the lock is now ours, not a conflict,
# so treat it as acquired instead of crashing before the tray loads.
try { $gotLock = $mutex.WaitOne(0) }
catch [System.Threading.AbandonedMutexException] { $gotLock = $true }
if (-not $gotLock) { exit 0 }

function Test-PiperOnline {
  try {
    $response = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 1
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch {
    return $false
  }
}

function Test-ProcessIdRunning {
  param([int]$ProcessId)
  return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Get-ManagedServerPid {
  if (-not (Test-Path $PidFile)) {
    return $null
  }

  try {
    $processId = [int]((Get-Content -LiteralPath $PidFile -Raw).Trim())
    if ($processId -gt 0 -and (Test-ProcessIdRunning $processId)) {
      return $processId
    }
  } catch {}

  return $null
}

function Start-PiperServer {
  Start-Process powershell -WindowStyle Hidden -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $StartScript
  )
}

function Stop-PiperServer {
  Start-Process powershell -WindowStyle Hidden -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $StopScript
  )
}

function Open-VoicesFolder {
  $voicesDir = Join-Path $ServerDir "piper\voices"
  New-Item -ItemType Directory -Force -Path $voicesDir | Out-Null
  Start-Process explorer.exe -ArgumentList "`"$voicesDir`""
}

function Get-TrayIcon {
  if (Test-Path $IconFile) {
    $bitmap = $null
    $handle = [System.IntPtr]::Zero
    try {
      $bitmap = [System.Drawing.Bitmap]::FromFile($IconFile)
      $handle = $bitmap.GetHicon()
      $icon = [System.Drawing.Icon]::FromHandle($handle)
      $clonedIcon = $icon.Clone()
      return [System.Drawing.Icon]$clonedIcon
    } finally {
      if ($handle -ne [System.IntPtr]::Zero) {
        [Win32.NativeMethods]::DestroyIcon($handle) | Out-Null
      }
      if ($bitmap) {
        $bitmap.Dispose()
      }
    }
  }
  return [System.Drawing.SystemIcons]::Application
}

# Builds a copy of the tray icon with a small status dot in the top-left corner.
function New-StatusIcon {
  param([System.Drawing.Color]$DotColor)
  $src = $null; $bmp = $null; $g = $null; $handle = [System.IntPtr]::Zero
  try {
    if (Test-Path $IconFile) {
      $src = [System.Drawing.Bitmap]::FromFile($IconFile)
      $bmp = New-Object System.Drawing.Bitmap $src, $src.Width, $src.Height
    } else {
      $bmp = ([System.Drawing.SystemIcons]::Application).ToBitmap()
    }
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $d = [int]($bmp.Width * 0.40)
    # Dark ring first (contrast on light icons), then the colored dot inside it.
    $g.FillEllipse([System.Drawing.Brushes]::Black, 0, 0, ($d + 3), ($d + 3))
    $brush = New-Object System.Drawing.SolidBrush $DotColor
    $g.FillEllipse($brush, 2, 2, $d, $d)
    $brush.Dispose()
    $handle = $bmp.GetHicon()
    $icon = [System.Drawing.Icon]::FromHandle($handle)
    return [System.Drawing.Icon]$icon.Clone()
  } finally {
    if ($handle -ne [System.IntPtr]::Zero) { [Win32.NativeMethods]::DestroyIcon($handle) | Out-Null }
    if ($g)   { $g.Dispose() }
    if ($bmp) { $bmp.Dispose() }
    if ($src) { $src.Dispose() }
  }
}

# Built once and reused, so the per-tick refresh never allocates GDI handles.
$script:IconOnline  = New-StatusIcon ([System.Drawing.Color]::FromArgb(255, 64, 192, 87))  # green
$script:IconOffline = New-StatusIcon ([System.Drawing.Color]::FromArgb(255, 224, 75, 59))  # red

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = $menu.Items.Add("Piper TTS: checking...")
$statusItem.Enabled = $false
$menu.Items.Add("-") | Out-Null
$startItem = $menu.Items.Add("Start Server")
$stopItem = $menu.Items.Add("Stop Server")
$menu.Items.Add("-") | Out-Null
$voicesItem = $menu.Items.Add("Open Voices Folder")
$exitItem = $menu.Items.Add("Exit")

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = Get-TrayIcon
$tray.Text = "Piper TTS"
$tray.ContextMenuStrip = $menu
$tray.Visible = $true

function Update-Tray {
  $online = Test-PiperOnline
  $managedPid = Get-ManagedServerPid
  $managed = $null -ne $managedPid

  if ($managed) {
    $statusItem.Text = "Piper TTS: online"
    $tray.Text = "Piper TTS - online"
  } elseif ($online) {
    $statusItem.Text = "Piper TTS: online (external)"
    $tray.Text = "Piper TTS - external server"
  } else {
    $statusItem.Text = "Piper TTS: offline"
    $tray.Text = "Piper TTS - offline"
  }

  # Green dot when a server is reachable, red when not.
  $tray.Icon = if ($online) { $script:IconOnline } else { $script:IconOffline }

  $startItem.Enabled = -not $online
  $stopItem.Enabled = $managed
  $stopItem.Text = if ($online -and -not $managed) { "Stop Server (managed only)" } else { "Stop Server" }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.Add_Tick({ Update-Tray })

$startItem.Add_Click({
  Start-PiperServer
  Start-Sleep -Milliseconds 700
  Update-Tray
})

$stopItem.Add_Click({
  Stop-PiperServer
  Start-Sleep -Milliseconds 700
  Update-Tray
})

$voicesItem.Add_Click({ Open-VoicesFolder })

$exitItem.Add_Click({
  $timer.Stop()
  $tray.Visible = $false
  $tray.Dispose()
  if ($script:IconOnline)  { $script:IconOnline.Dispose() }
  if ($script:IconOffline) { $script:IconOffline.Dispose() }
  [System.Windows.Forms.Application]::Exit()
})

Update-Tray
if ($AutoStartServer -and -not (Test-PiperOnline)) {
  Start-PiperServer
  Start-Sleep -Milliseconds 700
  Update-Tray
}
$timer.Start()
[System.Windows.Forms.Application]::Run()

try { $mutex.ReleaseMutex() | Out-Null } catch {}
$mutex.Dispose()

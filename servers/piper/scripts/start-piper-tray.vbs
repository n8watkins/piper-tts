' Launch the Piper TTS tray with NO console window (seamless background start).
' wscript.exe is a GUI-subsystem host (no console), and WshShell.Run(..., 0, False)
' starts node hidden — so there's no CMD flash, unlike a .bat launcher.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
trayJs = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "..\tray\piper-tray.js")
sh.Run "node """ & trayJs & """", 0, False

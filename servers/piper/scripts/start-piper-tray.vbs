' Old name of start-voicedock-tray.vbs (the tray was "Piper TTS Tray" up to
' VoiceDock 1.1). Kept so an old "Piper TTS Tray" startup shortcut still works;
' the tray replaces that shortcut with "VoiceDock Tray" when it starts.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
sh.Run "wscript """ & fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "start-voicedock-tray.vbs") & """", 0, False

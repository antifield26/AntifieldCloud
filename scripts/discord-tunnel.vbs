' AntifieldCloud Bot tunnel silent launcher.
' Starts discord-tunnel.ps1 in a hidden PowerShell window and waits for it.
' This file is intentionally ASCII-only; keep CRLF when editing on Windows.
Option Explicit

Dim fso, shell, baseDir, ps1, command
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(baseDir, "discord-tunnel.ps1")
If Not fso.FileExists(ps1) Then
  WScript.Quit 1
End If

command = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe") & _
  " -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & ps1 & """ -Internal"
shell.Run command, 0, True

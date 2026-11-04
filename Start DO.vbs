' Double-click to start DO on Windows. No console window appears; scripts\launcher.mjs
' opens DO's status window. If VBScript is ever turned off on this PC, run this instead:
' node scripts\launcher.mjs
Option Explicit
Dim shell, files
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
shell.CurrentDirectory = files.GetParentFolderName(WScript.ScriptFullName)
If shell.Run("cmd /c where node", 0, True) <> 0 Then
  MsgBox "Install Node.js 22 or newer and Git for Windows, then start DO again.", vbExclamation, "DO"
  WScript.Quit 1
End If
shell.Run "node scripts\launcher.mjs", 0, False

Option Explicit
Dim fso, module, command
Set fso = CreateObject("Scripting.FileSystemObject")
module = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
command = "pwsh.exe -NoProfile -STA -ExecutionPolicy Bypass -File """ & module & "\scripts\open-window.ps1"""
CreateObject("WScript.Shell").Run command, 0, False

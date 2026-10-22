$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$title = 'Desinstalar o RavokBot'
$ask = [System.Windows.Forms.MessageBox]::Show('Deseja remover o RavokBot deste computador?', $title, 'YesNo', 'Question')
if ($ask -ne 'Yes') { exit 0 }
$wipe = [System.Windows.Forms.MessageBox]::Show("Apagar também os dados do RavokBot (contas, proxies, sessão e perfis das telas)?`n`nEscolha Não para manter seus dados.", $title, 'YesNo', 'Question')
Get-Process -Name 'RavokBot' | Where-Object { $_.Path -like "$dir\*" } | Stop-Process -Force
Start-Sleep -Milliseconds 900
Remove-Item -Force (Join-Path ([Environment]::GetFolderPath('Desktop')) 'RavokBot.lnk')
Remove-Item -Force (Join-Path ([Environment]::GetFolderPath('Programs')) 'RavokBot.lnk')
Remove-Item -Recurse -Force 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\RavokBot'
if ($wipe -eq 'Yes') {
  foreach ($p in @("$env:APPDATA\RavokBot", "$env:APPDATA\ravokbot", "$env:LOCALAPPDATA\RavokBot", "$env:LOCALAPPDATA\ravokbot", "$env:LOCALAPPDATA\ravokbot-updater")) { Remove-Item -Recurse -Force $p }
}
Start-Process -WindowStyle Hidden -FilePath 'cmd.exe' -ArgumentList ('/c ping 127.0.0.1 -n 3 >nul & rmdir /s /q "' + $dir + '"')
[System.Windows.Forms.MessageBox]::Show('O RavokBot foi removido do seu computador.', $title, 'OK', 'Information') | Out-Null

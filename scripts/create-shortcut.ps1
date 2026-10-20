# 在桌面创建「额度桌宠」快捷方式，指向本项目自带的 Electron。
# 用法：npm run shortcut
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) {
    throw "没找到 $electron，请先在项目目录运行 npm install"
}

$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop '额度桌宠.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnk)
$shortcut.TargetPath = $electron
$shortcut.Arguments = '"' + $root + '"'
$shortcut.WorkingDirectory = $root
$shortcut.IconLocation = (Join-Path $root 'assets\icon.ico') + ',0'
$shortcut.Description = '额度桌宠：Codex / Claude / DeepSeek 额度一览'
$shortcut.Save()
Write-Host "已创建快捷方式：$lnk"

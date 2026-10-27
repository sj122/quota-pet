'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');

if (process.platform === 'win32') {
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'create-shortcut.ps1')], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
if (process.platform !== 'linux') throw new Error('桌面快捷方式目前支持 Windows 和 Linux');
const electron = path.join(root, 'node_modules/electron/dist/electron');
if (!fs.existsSync(electron)) throw new Error('请先运行 npm install 安装 Electron');
let desktop;
try { desktop = execFileSync('xdg-user-dir', ['DESKTOP'], { encoding: 'utf8' }).trim(); }
catch { desktop = path.join(os.homedir(), 'Desktop'); }
const quote = (s) => '"' + s.replace(/([\\"`$])/g, '\\$1').replace(/%/g, '%%') + '"';
const entry = `[Desktop Entry]\nType=Application\nName=额度桌宠\nComment=奶龙陪你查看 Codex、Claude 和 DeepSeek 用量\nExec=${quote(electron)} ${quote(root)}\nPath=${root}\nIcon=${path.join(root, 'assets/icon.png')}\nTerminal=false\nCategories=Utility;\n`;
fs.mkdirSync(desktop, { recursive: true });
const target = path.join(desktop, 'QuotaPet.desktop');
fs.writeFileSync(target, entry, { mode: 0o755 });
fs.chmodSync(target, 0o755);
const trust = spawnSync('gio', ['set', target, 'metadata::trusted', 'true'], { encoding: 'utf8' });
console.log(`已创建快捷方式：${target}`);
if (trust.status !== 0) console.log('首次启动如出现提示，请右键快捷方式选择“允许启动”。');

'use strict';

const os = require('os');
const path = require('path');

const home = os.homedir();
const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');

module.exports = {
  home,
  appData,
  localAppData,
  // Codex CLI / 桌面端共用的数据目录（auth.json、pets/ 都在这里）
  codexHome: process.env.CODEX_HOME || path.join(home, '.codex'),
  // Claude Code CLI 的配置目录（登录后会有 .credentials.json）
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
  // Claude 桌面端的数据目录（plan-usage-history.json 在这里）
  claudeDesktopDir: path.join(appData, 'Claude'),
};

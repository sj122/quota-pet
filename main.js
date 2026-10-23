'use strict';

const path = require('path');
const fs = require('fs');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  screen,
  protocol,
  nativeImage,
  net,
  session,
  powerMonitor,
  nativeTheme,
  shell,
} = require('electron');

const { Config } = require('./src/config');
const { JsonFile } = require('./src/store');
const { listPets } = require('./src/pets');
const { QuotaService, PROVIDERS } = require('./src/quota');
const { fetchCodex, findCodexExe } = require('./src/providers/codex');
const { fetchClaude, DESKTOP_HISTORY_FILE } = require('./src/providers/claude');
const deepseek = require('./src/providers/deepseek');
const QP = require('./renderer/shared');
const Physics = require('./renderer/physics');

const ROOT = __dirname;
const argValue = (name) => {
  const a = process.argv.find((x) => x.startsWith(`${name}=`));
  return a ? a.slice(name.length + 1) : null;
};
const SELFTEST = process.argv.includes('--selftest');
const SNAPSHOT_DIR = argValue('--snapshot');
const DEMO = process.argv.includes('--demo');
const INTERACTION_TEST_DIR = argValue('--interaction-test');
const TEST_DIR = INTERACTION_TEST_DIR || SNAPSHOT_DIR;
// 自动化使用独立配置，避免更改用户的主题、位置、隐藏设置和登录状态。
app.setPath('userData', TEST_DIR
  ? path.resolve(TEST_DIR, 'profile')
  : path.join(app.getPath('appData'), 'quota-pet'));

const PET_PAD_TOP = 84; // 宠物头顶留给气泡的高度
const PANEL_WIDTH = 384; // 卡片 344 + 两侧各 20px 投影留白
const PANEL_MARGIN = 20;
const MOTION_TICK = 16; // 抛飞、散步时每 16ms 挪一次窗口
const AWAY_AFTER_S = 5 * 60; // 电脑闲置 5 分钟，宠物就睡觉
const AWAY_REFRESH_MS = 30 * 60e3; // 人不在时最多半小时刷新一次
const EXTERNAL_HOSTS = ['platform.deepseek.com'];
const THEMES = [
  { label: '跟随系统', value: 'system' },
  { label: '浅色', value: 'light' },
  { label: '深色', value: 'dark' },
];
const SIZES = [
  { label: '小', value: 0.45 },
  { label: '中', value: 0.6 },
  { label: '大', value: 0.8 },
];
// 右键菜单“宠物行为”里的开关；眼睛跟随另外处理，旧版精灵图不支持
const BEHAVIORS = [
  { key: 'idleSelfPlay', label: '闲着时做小动作' },
  { key: 'wander', label: '闲着时四处走走' },
  { key: 'chatter', label: '看场合说说话' },
  { key: 'sleepWhenAway', label: '离开时睡觉，回来汇报' },
  { key: 'throwable', label: '可以甩出去' },
];

protocol.registerSchemesAsPrivileged([
  { scheme: 'qp', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let config;
let quota;
let tray = null;
let petWin = null;
let panelWin = null;
let settingsWin = null;
let pets = [];
let currentPet = null;
let trayIconImage = null;
let petIconDataUrl = null;
let panelHiddenAt = -Infinity;
let panelHeight = 460;
let dragOrigin = null;
let dragMoved = false;
let refreshTimer = null;
let cursorTimer = null;
let heartbeatTimer = null;
let lastBeat = null;
let lastPetHeartbeat = 0;
let petRefitTimer = null;
let resumeRefreshTimer = null;
let motion = null; // 正在由主进程移动宠物窗口：{ kind: 'fly' | 'walk', timer, ... }
let awaySince = null; // 判定为离开的起点（毫秒）；人在时为 null
let awayTimer = null;
let resetRefreshTimer = null;

const userFile = (name) => path.join(app.getPath('userData'), name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uiLog = [];
const logUi = (ev) => {
  if (TEST_DIR) uiLog.push(ev);
};

// 只记恢复相关事件，不记录额度、令牌或鼠标移动；两份日志合计最多约 512 KB。
function logRecovery(event, detail = {}) {
  try {
    const file = userFile('interaction.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 256 * 1024) {
      if (fs.existsSync(`${file}.1`)) fs.unlinkSync(`${file}.1`);
      fs.renameSync(file, `${file}.1`);
    }
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`);
  } catch {} // 日志写失败不能中断交互恢复。
}

// ---------- 网络 ----------

// 走 Chromium 网络栈，自动跟随 Windows 系统代理（也可以在设置里指定代理）。
async function fetchImpl(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    return await net.fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error('网络请求超时');
    throw new Error(`网络错误：${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// 主题交给 nativeTheme：所有页面的 prefers-color-scheme 会跟着变，CSS 里的深浅两套配色自动切换。
function applyTheme() {
  const t = config.get().theme;
  nativeTheme.themeSource = THEMES.some((x) => x.value === t) ? t : 'system';
}

const windowBg = () => (nativeTheme.shouldUseDarkColors ? '#1c1c1f' : '#f5f5f7');

async function applyProxy() {
  const p = String(config.get().proxy || '').trim();
  if (p) await session.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: p, proxyBypassRules: '<local>' });
  else await session.defaultSession.setProxy({ mode: 'system' });
}

function makeRunners() {
  const claudeHistory = new JsonFile(userFile('claude-history.json'), { samples: [] });
  const deepseekHistory = new JsonFile(userFile('deepseek-history.json'), { samples: [] });
  return {
    codex: () => fetchCodex({ fetchImpl, codexPath: config.get().codexPath }),
    claude: () => fetchClaude({ fetchImpl, historyStore: claudeHistory }),
    deepseek: () => deepseek.fetchDeepseek({ key: config.getDeepseekKey(), fetchImpl, historyStore: deepseekHistory }),
  };
}

// ---------- 宠物 ----------

function loadPets() {
  pets = listPets([{ dir: userFile('pets'), source: 'custom' }]);
  const want = config.get().petId;
  currentPet = pets.find((p) => p.id === want) || pets.find((p) => p.hasLookFrames) || pets[0] || null;
}

function spriteUrl(p) {
  return `qp://app/pet-sprite/${encodeURIComponent(p.id)}?v=${p.version}`;
}

function petInfo() {
  if (!currentPet) return null;
  const p = currentPet;
  return {
    id: p.id,
    displayName: p.displayName,
    rows: p.rows,
    columns: p.columns,
    cellW: p.cellW,
    cellH: p.cellH,
    hasLookFrames: p.hasLookFrames,
    spriteUrl: spriteUrl(p),
  };
}

function petMetrics() {
  const scale = Math.min(1.2, Math.max(0.3, Number(config.get().scale) || 0.6));
  const cellW = currentPet ? currentPet.cellW : 192;
  const cellH = currentPet ? currentPet.cellH : 208;
  const spriteW = Math.round(cellW * scale);
  const spriteH = Math.round(cellH * scale);
  return { scale, spriteW, spriteH, width: Math.max(260, spriteW + 24), height: spriteH + PET_PAD_TOP, padTop: PET_PAD_TOP };
}

// 位置按“脚底中心点”保存，换宠物、调大小时脚下不动。
const boundsFromAnchor = (a, m) => ({
  x: Math.round(a.cx - m.width / 2),
  y: Math.round(a.bottom - m.height),
  width: m.width,
  height: m.height,
});
const anchorFromBounds = (b) => ({ cx: b.x + b.width / 2, bottom: b.y + b.height });

function anchorVisible(a) {
  if (!a || !Number.isFinite(a.cx) || !Number.isFinite(a.bottom)) return false;
  return screen.getAllDisplays().some((d) => {
    const r = d.bounds;
    return a.cx >= r.x && a.cx <= r.x + r.width && a.bottom - 30 >= r.y && a.bottom - 30 <= r.y + r.height;
  });
}

function defaultAnchor(m) {
  const wa = screen.getPrimaryDisplay().workArea;
  return { cx: wa.x + wa.width - m.width / 2 - 36, bottom: wa.y + wa.height };
}

// 优先回到保存的位置；那块屏不在了就沿用当前位置，都不在屏幕上再放回主屏右下角。
function petAnchor(m) {
  const current = petWin && !petWin.isDestroyed() ? anchorFromBounds(petWin.getBounds()) : null;
  const a = [config.get().position, current].find(anchorVisible) || defaultAnchor(m);
  const wa = screen.getDisplayNearestPoint({ x: Math.round(a.cx), y: Math.round(a.bottom - 30) }).workArea;
  // 分辨率缩小或任务栏移动后，脚底仍在屏幕内也可能只露出半只宠物。
  const x = Math.max(wa.x, Math.min(a.cx - m.width / 2, wa.x + wa.width - m.width));
  const y = Math.max(wa.y, Math.min(a.bottom - m.height, wa.y + wa.height - m.height));
  return anchorFromBounds({ x, y, width: m.width, height: m.height });
}

// ---------- 窗口 ----------

function webPrefs(extra = {}) {
  return {
    preload: path.join(ROOT, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
    ...extra,
  };
}

const sendTo = (win, channel, payload) => {
  // 渲染进程崩溃、还没重新加载完时发了也收不到，Electron 还会报错。
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed() && !win.webContents.isCrashed()) {
    win.webContents.send(channel, payload);
  }
};
const broadcast = (channel, payload) => [petWin, panelWin, settingsWin].forEach((w) => sendTo(w, channel, payload));

// 渲染进程崩溃或被系统回收后，窗口还在、页面却没了，不重启就一直是个点不动的空壳；隔一秒自动重新加载。
function reloadOnCrash(win, onGone) {
  let reloadTimer = null;
  win.webContents.on('render-process-gone', (_event, details) => {
    logRecovery('renderer-gone', { window: win.getTitle(), reason: details.reason, exitCode: details.exitCode });
    if (onGone) onGone();
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      if (!win.isDestroyed()) win.reload();
    }, 1000);
  });
  win.on('closed', () => clearTimeout(reloadTimer));
}

function createPetWindow() {
  const m = petMetrics();
  petWin = new BrowserWindow({
    ...boundsFromAnchor(petAnchor(m), m),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    thickFrame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    title: 'QuotaPet',
    webPreferences: webPrefs({ backgroundThrottling: false }),
  });
  petWin.setAlwaysOnTop(true, 'screen-saver');
  // 透明区域鼠标穿透；渲染进程发现鼠标落在宠物不透明像素上时再关掉穿透
  petWin.setIgnoreMouseEvents(true, { forward: true });
  petWin.loadURL('qp://app/renderer/pet.html');
  // 缩放按源（qp://app）共享并会记进配置。旧版的默认菜单能用 Ctrl+加号 放大面板，宠物也被一起放大，
  // 页面坐标就和窗口对不上了；每次加载都恢复 100%。
  const wc = petWin.webContents;
  wc.on('did-finish-load', () => {
    wc.setZoomLevel(0);
    lastPetHeartbeat = performance.now();
    restorePetInteraction();
    // 页面崩溃重载时人还没回来：接着睡
    if (awaySince) sendTo(petWin, 'pet:away', { away: true });
  });
  // 页面没了先恢复穿透、丢掉拖动状态，免得这块透明窗口挡住桌面。
  reloadOnCrash(petWin, resetPetInteraction);
  petWin.once('ready-to-show', () => {
    if (!config.get().petHidden) petWin.showInactive();
  });
  petWin.on('closed', () => {
    petWin = null;
  });
}

function createPanelWindow() {
  panelWin = new BrowserWindow({
    width: PANEL_WIDTH,
    height: panelHeight,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    thickFrame: false,
    resizable: false,
    movable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: '额度一览',
    webPreferences: webPrefs(),
  });
  panelWin.setAlwaysOnTop(true, 'pop-up-menu');
  panelWin.loadURL('qp://app/renderer/panel.html');
  reloadOnCrash(panelWin, hidePanel);
  panelWin.on('blur', () => {
    if (!TEST_DIR) hidePanel();
  });
  panelWin.on('closed', () => {
    panelWin = null;
  });
}

// 面板优先放在宠物左侧（底边对齐），放不下再试右侧、上方、下方。
function placePanel() {
  if (!panelWin || panelWin.isDestroyed() || !petWin) return;
  const m = petMetrics();
  const b = petWin.getBounds();
  const sprite = { x: b.x + (b.width - m.spriteW) / 2, y: b.y + b.height - m.spriteH, w: m.spriteW, h: m.spriteH };
  const wa = screen.getDisplayNearestPoint({
    x: Math.round(sprite.x + sprite.w / 2),
    y: Math.round(sprite.y + sprite.h / 2),
  }).workArea;
  const W = PANEL_WIDTH;
  const H = Math.min(panelHeight, wa.height);
  const gap = 4 - PANEL_MARGIN;
  const candidates = [
    { x: sprite.x - W - gap, y: sprite.y + sprite.h - H + PANEL_MARGIN },
    { x: sprite.x + sprite.w + gap, y: sprite.y + sprite.h - H + PANEL_MARGIN },
    { x: sprite.x + sprite.w / 2 - W / 2, y: sprite.y - H - gap },
    { x: sprite.x + sprite.w / 2 - W / 2, y: sprite.y + sprite.h + gap },
  ];
  const fits = (c) => c.x >= wa.x && c.y >= wa.y && c.x + W <= wa.x + wa.width && c.y + H <= wa.y + wa.height;
  const c = candidates.find(fits) || candidates[0];
  panelWin.setBounds({
    x: Math.round(Math.min(Math.max(c.x, wa.x), wa.x + wa.width - W)),
    y: Math.round(Math.min(Math.max(c.y, wa.y), wa.y + wa.height - H)),
    width: W,
    height: Math.round(H),
  });
}

function showPanel() {
  if (!panelWin || panelWin.isDestroyed()) createPanelWindow();
  stopMotion('panel'); // 面板按宠物的位置摆放，宠物得先站住
  placePanel();
  panelWin.show();
  panelWin.focus();
  sendTo(petWin, 'panel:visible', true);
  if (quota.staleness() > 60e3) quota.refresh();
  else quota.refresh(['claude'], { silent: true });
}

function hidePanel() {
  if (!panelWin || panelWin.isDestroyed() || !panelWin.isVisible()) return;
  panelHiddenAt = performance.now();
  panelWin.hide();
  sendTo(petWin, 'panel:visible', false);
}

function togglePanel() {
  if (panelWin && !panelWin.isDestroyed() && panelWin.isVisible()) return hidePanel();
  // 点宠物时面板可能先因失焦被收起，这里避免紧接着又弹出来。
  // 用单调时钟：系统校时把时间往回拨时，Date.now() 会让这里长时间以为“刚收起”。
  if (performance.now() - panelHiddenAt < 300) return;
  showPanel();
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  hidePanel();
  settingsWin = new BrowserWindow({
    width: 580,
    height: 760,
    minWidth: 480,
    minHeight: 520,
    show: false,
    title: '额度桌宠 · 设置',
    backgroundColor: windowBg(),
    autoHideMenuBar: true,
    icon: trayIconImage || fallbackIcon(),
    webPreferences: webPrefs(),
  });
  settingsWin.removeMenu();
  settingsWin.loadURL('qp://app/renderer/settings.html');
  reloadOnCrash(settingsWin);
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

// ---------- 托盘与菜单 ----------

function fallbackIcon() {
  return nativeImage.createFromPath(path.join(ROOT, 'assets', 'icon.png'));
}

function loginArgs() {
  if (app.isPackaged) return [];
  const p = app.getAppPath();
  return [/\s/.test(p) ? `"${p}"` : p];
}

function getAutoStart() {
  try {
    return app.getLoginItemSettings({ path: process.execPath, args: loginArgs() }).openAtLogin;
  } catch {
    return false;
  }
}

function setAutoStart(on) {
  app.setLoginItemSettings({ openAtLogin: Boolean(on), path: process.execPath, args: loginArgs() });
  rebuildMenu();
  broadcast('config:changed', publicConfig());
}

function setPetHidden(hidden) {
  config.set({ petHidden: Boolean(hidden) });
  if (petWin) {
    if (hidden) {
      stopMotion('hidden');
      hidePanel();
      petWin.hide();
    } else {
      petWin.showInactive();
    }
  }
  rebuildMenu();
}

function buildMenu() {
  const cfg = config.get();
  const petItems = pets.length
    ? pets.map((p) => ({
        label: p.displayName,
        type: 'radio',
        checked: Boolean(currentPet && p.id === currentPet.id),
        click: () => setPet(p.id),
      }))
    : [{ label: '没找到宠物（~/.codex/pets）', enabled: false }];
  return Menu.buildFromTemplate([
    { label: '查看额度', click: () => showPanel() },
    { label: '立即刷新', click: () => quota.refresh() },
    { type: 'separator' },
    {
      label: '切换宠物',
      submenu: [...petItems, { type: 'separator' }, { label: '重新扫描宠物', click: () => rescanPets() }],
    },
    {
      label: '宠物大小',
      submenu: SIZES.map((s) => ({
        label: s.label,
        type: 'radio',
        checked: Math.abs(cfg.scale - s.value) < 0.001,
        click: () => updateConfig({ scale: s.value }),
      })),
    },
    {
      label: '宠物行为',
      submenu: [
        {
          label: '眼睛跟着鼠标',
          type: 'checkbox',
          checked: cfg.eyeFollow,
          enabled: Boolean(currentPet && currentPet.hasLookFrames),
          click: (item) => updateConfig({ eyeFollow: item.checked }),
        },
        ...BEHAVIORS.map(({ key, label }) => ({
          label,
          type: 'checkbox',
          checked: cfg[key] !== false,
          click: (item) => updateConfig({ [key]: item.checked }),
        })),
      ],
    },
    {
      label: '外观',
      submenu: THEMES.map((t) => ({
        label: t.label,
        type: 'radio',
        checked: (cfg.theme || 'system') === t.value,
        click: () => updateConfig({ theme: t.value }),
      })),
    },
    { type: 'separator' },
    { label: '设置…', click: () => openSettings() },
    { label: '开机自动启动', type: 'checkbox', checked: getAutoStart(), click: (item) => setAutoStart(item.checked) },
    { label: cfg.petHidden ? '显示宠物' : '隐藏宠物', click: () => setPetHidden(!cfg.petHidden) },
    { label: '恢复宠物交互', click: () => reactivatePet('manual') },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
}

function rebuildMenu() {
  if (tray) tray.setContextMenu(buildMenu());
}

function createTray() {
  tray = new Tray(trayIconImage || fallbackIcon());
  tray.setToolTip('额度桌宠');
  tray.on('click', () => {
    if (config.get().petHidden) setPetHidden(false);
    togglePanel();
  });
  rebuildMenu();
}

// ---------- 配置 ----------

function publicConfig() {
  return { ...config.publicView(), autoStart: getAutoStart() };
}

function fullState() {
  return {
    quota: quota.snapshot(),
    config: publicConfig(),
    pet: petInfo(),
    metrics: petMetrics(),
    petIcon: petIconDataUrl,
    pets: pets.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      description: p.description,
      hasLookFrames: p.hasLookFrames,
      rows: p.rows,
      columns: p.columns,
      spriteUrl: spriteUrl(p),
    })),
    codexDetected: findCodexExe(''),
    claudeDesktopFile: DESKTOP_HISTORY_FILE,
  };
}

function applyPet() {
  if (!petWin) return;
  stopMotion('resize');
  const m = petMetrics();
  petWin.setBounds(boundsFromAnchor(anchorFromBounds(petWin.getBounds()), m));
  sendTo(petWin, 'pet:changed', { pet: petInfo(), metrics: m, config: publicConfig() });
  sendEdge();
}

function setPet(id) {
  updateConfig({ petId: id });
}

function rescanPets() {
  loadPets();
  applyPet();
  rebuildMenu();
  broadcast('config:changed', publicConfig());
}

const clampNum = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

function sanitize(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  if ('refreshMinutes' in patch) out.refreshMinutes = Math.round(clampNum(patch.refreshMinutes, 1, 120, 5));
  if ('alertPercent' in patch) out.alertPercent = Math.round(clampNum(patch.alertPercent, 1, 50, 10));
  if ('lowBalance' in patch) out.lowBalance = clampNum(patch.lowBalance, 0, 1e6, 10);
  if ('scale' in patch) out.scale = clampNum(patch.scale, 0.3, 1.2, 0.6);
  for (const k of ['eyeFollow', ...BEHAVIORS.map((b) => b.key)]) if (k in patch) out[k] = Boolean(patch[k]);
  for (const k of ['codexPath', 'proxy']) if (k in patch) out[k] = String(patch[k] || '').trim().slice(0, 500);
  if ('petId' in patch && pets.some((p) => p.id === patch.petId)) out.petId = patch.petId;
  if ('theme' in patch && THEMES.some((t) => t.value === patch.theme)) out.theme = patch.theme;
  if (patch.providers && typeof patch.providers === 'object') {
    out.providers = {};
    for (const n of PROVIDERS) if (n in patch.providers) out.providers[n] = Boolean(patch.providers[n]);
  }
  return out;
}

function updateConfig(patch) {
  config.set(patch);
  if ('petId' in patch) currentPet = pets.find((p) => p.id === patch.petId) || currentPet;
  if ('petId' in patch || 'scale' in patch) applyPet();
  if ('theme' in patch) applyTheme();
  if ('refreshMinutes' in patch) scheduleRefresh();
  if ('proxy' in patch) applyProxy().then(() => quota.refresh());
  if ('codexPath' in patch) quota.refresh(['codex']);
  if ('providers' in patch) quota.refresh();
  if (patch.wander === false && motion && motion.kind === 'walk') stopMotion('off');
  if (patch.sleepWhenAway === false) checkAway(); // 正睡着就叫醒，不汇报
  if ('eyeFollow' in patch || 'idleSelfPlay' in patch || 'alertPercent' in patch || 'lowBalance' in patch) {
    sendTo(petWin, 'config:changed', publicConfig());
  }
  rebuildMenu();
  broadcast('config:changed', publicConfig());
  return publicConfig();
}

// ---------- 刷新调度 ----------

function scheduleRefresh() {
  clearInterval(refreshTimer);
  const mins = clampNum(config.get().refreshMinutes, 1, 120, 5);
  refreshTimer = setInterval(() => {
    // 人不在时降到半小时一次，回来时再补刷
    if (awaySince && Date.now() - (quota.lastRefreshAt || 0) < AWAY_REFRESH_MS) return;
    quota.refresh();
  }, mins * 60e3);
}

// 在最近一个额度窗口的重置时间之后补刷一次，宠物能马上为“额度回满”庆祝，不用等下一轮定时刷新。
// 太远的（比如几天后的周额度）先不排，之后每次刷新都会重新安排。
function scheduleResetRefresh(snap) {
  clearTimeout(resetRefreshTimer);
  resetRefreshTimer = null;
  const now = Date.now();
  let next = Infinity;
  let names = [];
  for (const name of ['codex', 'claude']) {
    const slot = snap[name];
    const d = slot && slot.data;
    if (!d || slot.status === 'off' || !Array.isArray(d.windows)) continue;
    for (const w of d.windows) {
      if (!(w.resetsAt > now)) continue;
      if (w.resetsAt < next - 60e3) {
        next = w.resetsAt;
        names = [name];
      } else if (w.resetsAt <= next + 60e3 && !names.includes(name)) names.push(name);
    }
  }
  if (!names.length || next - now > 6 * 3600e3) return;
  resetRefreshTimer = setTimeout(() => {
    resetRefreshTimer = null;
    if (!awaySince) quota.refresh(names);
  }, next - now + 15e3);
}

function watchClaudeDesktop() {
  fs.watchFile(DESKTOP_HISTORY_FILE, { interval: 15000 }, (cur, prev) => {
    if (cur.mtimeMs !== prev.mtimeMs) quota.refresh(['claude'], { silent: true });
  });
}

// 鼠标相对宠物窗口的位置连同窗口尺寸一起给页面，由页面按视口比例换成 CSS 像素：
// 页面被缩放、或缩放比例没跟上显示器时，窗口像素和 CSS 像素并不是 1:1。
// Windows 上先换成物理像素：几块屏缩放不同时，DIP 坐标跨屏不连续。
function cursorInPet() {
  const p = screen.getCursorScreenPoint();
  const b = petWin.getBounds();
  if (process.platform !== 'win32') return { x: p.x - b.x, y: p.y - b.y, w: b.width, h: b.height };
  const pp = screen.dipToScreenPoint(p);
  const pb = screen.dipToScreenRect(petWin, b);
  return { x: pp.x - pb.x, y: pp.y - pb.y, w: pb.width, h: pb.height };
}

// 渲染进程拿不到窗口外的鼠标位置，由主进程轮询后转发（用于眼睛跟随和穿透判断）
function startCursorPolling() {
  let last = '';
  let lastSentAt = 0;
  let lastHitTestAt = -Infinity;
  cursorTimer = setInterval(() => {
    if (!petWin || petWin.isDestroyed() || !petWin.isVisible()) return;
    const c = cursorInPet();
    const key = `${c.x},${c.y},${c.w},${c.h}`;
    const now = performance.now();
    // 静止时也定期校准，避免窗口隐藏/恢复或重载后沿用旧的穿透状态。
    if (key === last && now - lastSentAt < 1000) return;
    last = key;
    lastSentAt = now;
    // Windows/远程桌面可能改变原生窗口样式，页面缓存的 interactive 值不能代表原生状态。
    const forceHitTest = now - lastHitTestAt >= 1000;
    if (forceHitTest) lastHitTestAt = now;
    sendTo(petWin, 'pet:cursor', { ...c, forceHitTest });
  }, 50);
}

function endPetDrag() {
  if (dragOrigin && dragMoved && petWin && !petWin.isDestroyed()) {
    logUi({ ev: 'drag', dx: petWin.getBounds().x - dragOrigin.x, dy: petWin.getBounds().y - dragOrigin.y });
    if (!TEST_DIR) config.set({ position: anchorFromBounds(petWin.getBounds()) });
    sendEdge();
  }
  dragOrigin = null;
  dragMoved = false;
}

function resetPetInteraction() {
  stopMotion('reset');
  endPetDrag();
  if (!petWin || petWin.isDestroyed()) return;
  // 锁屏会切换 Windows 桌面，非聚焦窗口未必收到 blur/pointerup。
  // 同时清掉页面缓存、捕获和原生穿透转发；仅重发鼠标坐标会被页面的状态去重跳过。
  petWin.setIgnoreMouseEvents(false);
  petWin.setIgnoreMouseEvents(true, { forward: true });
  sendTo(petWin, 'pet:interaction-reset');
}

function restorePetInteraction() {
  if (!petWin || petWin.isDestroyed()) return;
  resetPetInteraction();
  const m = petMetrics();
  petWin.setBounds(boundsFromAnchor(petAnchor(m), m));
  petWin.webContents.setZoomLevel(0);
  petWin.setAlwaysOnTop(true, 'screen-saver');
  if (!config.get().petHidden && !petWin.isVisible()) petWin.showInactive();
  placePanel();
  sendEdge();
  // 不等鼠标移动或轮询去重超时，立即让页面按当前位置重新命中测试。
  sendTo(petWin, 'pet:cursor', cursorInPet());
}

// 显示器唤醒、插拔或改缩放后，再等布局稳定校准一次；用户已开始新的拖动时不打断它。
function schedulePetRefit() {
  clearTimeout(petRefitTimer);
  petRefitTimer = setTimeout(() => {
    petRefitTimer = null;
    if (dragOrigin) schedulePetRefit();
    else restorePetInteraction();
  }, 1500);
}

function watchDisplays() {
  for (const name of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(name, (_event, display, changedMetrics) => {
      logRecovery(name, {
        display: display && { id: display.id, bounds: display.bounds, scaleFactor: display.scaleFactor },
        changedMetrics,
      });
      // 旧拖动基于旧屏幕坐标，先取消；不能等拖动结束才恢复，否则漏收松手会永久跳过校准。
      hidePanel();
      resetPetInteraction();
      schedulePetRefit();
    });
  }
}

// 解锁、唤醒，或心跳发现系统睡过一觉之后：重新校准宠物窗口，稍后刷新一次额度。
function reactivatePet(reason = 'resume') {
  logRecovery('reactivate', { reason });
  lastPetHeartbeat = performance.now();
  panelHiddenAt = -Infinity;
  restorePetInteraction();
  schedulePetRefit();
  clearTimeout(resumeRefreshTimer);
  resumeRefreshTimer = setTimeout(() => quota.refresh(), 5000);
}

// 系统通知只用来触发可重复执行的复位和校准，不记“已锁屏/已休眠”去拦交互：Windows 的解锁、唤醒通知
// 并不总是成对送达（现代待机、远程桌面、快速切换用户），标志一旦没被清掉，宠物就再也点不开、拖不动。
// 锁屏时本来就碰不到宠物，用不着拦。
function watchPowerEvents() {
  const deactivate = () => {
    clearTimeout(petRefitTimer);
    clearTimeout(resumeRefreshTimer);
    hidePanel();
    resetPetInteraction();
  };
  for (const name of ['lock-screen', 'suspend']) powerMonitor.on(name, () => {
    logRecovery(name);
    deactivate();
  });
  for (const name of ['unlock-screen', 'resume']) powerMonitor.on(name, () => reactivatePet(name));
}

function checkPetHeartbeat(now) {
  if (!petWin || petWin.isDestroyed() || !petWin.isVisible()) {
    lastPetHeartbeat = now;
    return;
  }
  // 这里只暂缓页面健康检查；不把系统通知缓存为永久阻止拖动/点击的标志。
  if (powerMonitor.getSystemIdleState(60) === 'locked') {
    lastPetHeartbeat = now;
    return;
  }
  const wc = petWin.webContents;
  if (wc.isDestroyed() || wc.isCrashed() || wc.isLoadingMainFrame() || now - lastPetHeartbeat < 15000) return;
  logRecovery('renderer-heartbeat-timeout', { silentMs: Math.round(now - lastPetHeartbeat) });
  lastPetHeartbeat = now;
  // reload 无法打断卡住的 JavaScript；先结束失去响应的渲染进程，gone 监听器负责重载。
  wc.forcefullyCrashRenderer();
}

// 通知漏发时的兜底：心跳停摆了好几秒，说明系统睡过或主线程卡过，按刚唤醒处理一次。
// 单调时钟和系统时钟都看，睡眠期间哪个不走都能发现。
function watchClockGaps() {
  lastBeat = { mono: performance.now(), wall: Date.now() };
  heartbeatTimer = setInterval(() => {
    const beat = { mono: performance.now(), wall: Date.now() };
    const gap = Math.max(beat.mono - lastBeat.mono, beat.wall - lastBeat.wall);
    lastBeat = beat;
    if (gap > 5000) reactivatePet('clock-gap');
    else checkPetHeartbeat(beat.mono);
  }, 1000);
}

// ---------- 甩出去、散步：主进程按物理推进窗口，页面只负责动作和挤压效果 ----------

// 宠物身体：窗口底部居中的精灵图那一块
function petBody(b, m) {
  return { x: b.x + (b.width - m.spriteW) / 2, y: b.y + b.height - m.spriteH, w: m.spriteW, h: m.spriteH };
}

const boundsFromBody = (x, y, m) => ({
  x: Math.round(x - (m.width - m.spriteW) / 2),
  y: Math.round(y + m.spriteH - m.height),
  width: m.width,
  height: m.height,
});

// 身体左上角能到的范围：起飞时所在屏幕的工作区，脚踩在任务栏上沿。
// 贴边时窗口两侧的透明部分会露到屏幕外，和手动拖到屏幕边上一样。
function bodyBox(body) {
  const wa = screen.getDisplayNearestPoint({ x: Math.round(body.x + body.w / 2), y: Math.round(body.y + body.h / 2) }).workArea;
  return {
    minX: wa.x,
    maxX: Math.max(wa.x, wa.x + wa.width - body.w),
    minY: wa.y,
    maxY: Math.max(wa.y, wa.y + wa.height - body.h),
  };
}

// 宠物贴着屏幕边时窗口有一截在屏幕外，告诉页面把气泡往里挪
function sendEdge() {
  if (!petWin || petWin.isDestroyed()) return;
  const b = petWin.getBounds();
  const wa = screen.getDisplayNearestPoint({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height - 30) }).workArea;
  sendTo(petWin, 'pet:edge', {
    left: Math.max(0, wa.x - b.x),
    right: Math.max(0, b.x + b.width - (wa.x + wa.width)),
  });
}

function stopMotion(reason) {
  if (!motion) return;
  const was = motion;
  motion = null;
  clearInterval(was.timer);
  logUi({ ev: 'motion-end', kind: was.kind, reason });
  sendTo(petWin, 'pet:motion', { kind: 'end', reason, was: was.kind, impact: Math.round(was.maxImpact || 0) });
}

// 页面传来的松手速度要校验：必须是有限数字，再限一下上限
function flingVelocity(v) {
  if (!v || typeof v !== 'object') return null;
  const vx = Number(v.vx);
  const vy = Number(v.vy);
  const speed = Math.hypot(vx, vy);
  if (!Number.isFinite(speed) || speed < Physics.RELEASE.deadZone) return null;
  const k = Math.min(1, Physics.RELEASE.cap / speed);
  return { vx: vx * k, vy: vy * k };
}

function startFlight(v) {
  stopMotion('replaced');
  if (!petWin || petWin.isDestroyed() || !petWin.isVisible()) return false;
  const m = petMetrics();
  const body = petBody(petWin.getBounds(), m);
  const box = bodyBox(body);
  const now = performance.now();
  motion = {
    kind: 'fly', m, box, started: now, last: now, maxImpact: 0, sliding: false, timer: null,
    s: { x: Math.min(Math.max(body.x, box.minX), box.maxX), y: Math.min(Math.max(body.y, box.minY), box.maxY), vx: v.vx, vy: v.vy },
  };
  hidePanel();
  logUi({ ev: 'fly', vx: Math.round(v.vx), vy: Math.round(v.vy) });
  sendTo(petWin, 'pet:motion', { kind: 'fly' });
  motion.timer = setInterval(stepFlight, MOTION_TICK);
  return true;
}

function stepFlight() {
  const mo = motion;
  if (!mo || mo.kind !== 'fly') return;
  if (!petWin || petWin.isDestroyed()) return stopMotion('gone');
  const now = performance.now();
  const { state, hits } = Physics.flightStep(mo.s, (now - mo.last) / 1000, mo.box);
  mo.last = now;
  mo.s = state;
  for (const hit of hits) {
    if (hit.side === 'floor') mo.maxImpact = Math.max(mo.maxImpact, hit.speed);
    if (hit.speed >= 250) sendTo(petWin, 'pet:motion', { kind: 'impact', side: hit.side, speed: Math.round(hit.speed) });
  }
  // 不再弹起、还在贴地滑：换成跑步动作
  if (!mo.sliding && Physics.grounded(state, mo.box) && state.vy === 0 && Math.abs(state.vx) >= 80) {
    mo.sliding = true;
    sendTo(petWin, 'pet:motion', { kind: 'slide', dir: state.vx < 0 ? 'left' : 'right' });
  }
  const timedOut = now - mo.started > 15000; // 兜底：怎么也停不下来就直接落地
  if (timedOut) mo.s = { ...state, y: mo.box.maxY, vx: 0, vy: 0 };
  petWin.setBounds(boundsFromBody(mo.s.x, mo.s.y, mo.m));
  if (timedOut || Physics.atRest(mo.s, mo.box)) {
    if (!TEST_DIR) config.set({ position: anchorFromBounds(petWin.getBounds()) });
    stopMotion('land');
    sendEdge();
  }
}

// 散步：只在任务栏上沿走，离“家”（用户最后放下它的位置）不超过两三个身位
function startWalk() {
  if (motion || dragOrigin || !petWin || petWin.isDestroyed() || !petWin.isVisible()) return false;
  if (panelWin && !panelWin.isDestroyed() && panelWin.isVisible()) return false;
  const m = petMetrics();
  const body = petBody(petWin.getBounds(), m);
  const box = bodyBox(body);
  if (Math.abs(body.y - box.maxY) > 2) return false; // 被放在半空（比如别的窗口顶上）就不乱走
  const home = config.get().position;
  const homeX = home && Number.isFinite(home.cx) ? home.cx - m.spriteW / 2 : body.x;
  const target = Physics.walkTarget({
    x: body.x, minX: box.minX, maxX: box.maxX, home: homeX,
    leash: Math.max(160, m.spriteW * 2.5), minStep: Math.max(40, m.spriteW * 0.5), maxStep: Math.max(120, m.spriteW * 2),
  });
  if (target == null) return false;
  const dir = target < body.x ? -1 : 1;
  const now = performance.now();
  motion = {
    kind: 'walk', m, x: body.x, y: box.maxY, target, dir, timer: null, started: now, last: now,
    speed: Math.min(110, Math.max(45, m.spriteW * 0.7)),
  };
  sendTo(petWin, 'pet:motion', { kind: 'walk', dir: dir < 0 ? 'left' : 'right' });
  motion.timer = setInterval(stepWalk, MOTION_TICK);
  return true;
}

function stepWalk() {
  const mo = motion;
  if (!mo || mo.kind !== 'walk') return;
  if (!petWin || petWin.isDestroyed()) return stopMotion('gone');
  const now = performance.now();
  mo.x += mo.dir * mo.speed * Math.min(0.05, (now - mo.last) / 1000);
  mo.last = now;
  const arrived = mo.dir < 0 ? mo.x <= mo.target : mo.x >= mo.target;
  if (arrived) mo.x = mo.target;
  petWin.setBounds(boundsFromBody(mo.x, mo.y, mo.m));
  if (arrived || now - mo.started > 20000) {
    stopMotion('arrived');
    sendEdge();
  }
}

// ---------- 离开就睡，回来汇报 ----------

// 电脑闲置够久算离开；有输入、而且没锁屏才算回来（锁屏界面输密码不算，免得汇报气泡出现在锁屏后面）
function checkAway() {
  if (!petWin || petWin.isDestroyed()) return;
  const enabled = config.get().sleepWhenAway !== false;
  if (!awaySince) {
    if (!enabled) return;
    const idle = powerMonitor.getSystemIdleTime();
    if (idle < AWAY_AFTER_S) return;
    awaySince = Date.now() - idle * 1000;
    stopMotion('away');
    sendTo(petWin, 'pet:away', { away: true });
  } else if (!enabled) {
    awaySince = null;
    sendTo(petWin, 'pet:away', { away: false, silent: true });
  } else if (powerMonitor.getSystemIdleTime() < 10 && powerMonitor.getSystemIdleState(1) !== 'locked') {
    const awayMs = Date.now() - awaySince;
    awaySince = null;
    sendTo(petWin, 'pet:away', { away: false, awayMs });
    if (quota.staleness() > 60e3) quota.refresh();
  }
}

function watchAway() {
  clearInterval(awayTimer);
  awayTimer = setInterval(checkAway, 2000);
}

function onQuotaUpdate(snap) {
  broadcast('quota:update', snap);
  if (tray) tray.setToolTip(['额度桌宠', ...QP.summaryLines(snap)].join('\n').slice(0, 127));
  if (!snap.refreshing) scheduleResetRefresh(snap);
}

// ---------- 自定义协议：页面、资源和宠物精灵图都从 qp://app/ 提供，保证同源 ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const notFound = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });

function registerProtocol() {
  protocol.handle('qp', async (req) => {
    let url;
    try {
      url = new URL(req.url);
    } catch {
      return notFound();
    }
    if (url.hostname !== 'app') return notFound();
    const p = decodeURIComponent(url.pathname);
    if (p.startsWith('/pet-sprite/')) {
      const pet = pets.find((x) => x.id === p.slice('/pet-sprite/'.length));
      if (!pet) return notFound();
      try {
        const body = await fs.promises.readFile(pet.spritePath);
        return new Response(body, { headers: { 'content-type': pet.mime, 'cache-control': 'no-store' } });
      } catch {
        return notFound();
      }
    }
    const file = path.resolve(ROOT, `.${p}`);
    const allowed = ['renderer', 'assets'].some((d) => file.startsWith(path.join(ROOT, d) + path.sep));
    if (!allowed) return notFound();
    try {
      const body = await fs.promises.readFile(file);
      return new Response(body, { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
    } catch {
      return notFound();
    }
  });
}

// ---------- IPC ----------

function trusted(e) {
  try {
    return new URL(e.senderFrame.url).protocol === 'qp:';
  } catch {
    return false;
  }
}

function registerIpc() {
  ipcMain.handle('state:get', (e) => (trusted(e) ? fullState() : null));
  ipcMain.handle('quota:refresh', async (e) => {
    if (trusted(e)) await quota.refresh();
  });
  ipcMain.on('settings:open', (e) => trusted(e) && openSettings());
  ipcMain.on('open-external', (e, url) => {
    if (!trusted(e) || typeof url !== 'string') return;
    try {
      const u = new URL(url);
      if (u.protocol === 'https:' && EXTERNAL_HOSTS.includes(u.hostname)) shell.openExternal(u.toString());
    } catch {}
  });

  ipcMain.on('pet:ignore-mouse', (e, ignore) => {
    if (!trusted(e) || !petWin) return;
    petWin.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
    logUi({ ev: 'ignore', value: Boolean(ignore) });
  });
  ipcMain.on('pet:heartbeat', (e) => {
    if (petWin && e.sender === petWin.webContents && trusted(e)) lastPetHeartbeat = performance.now();
  });
  ipcMain.on('pet:drag-start', (e) => {
    if (!trusted(e) || !petWin) return;
    stopMotion('catch'); // 飞在半空、正在散步时按住，就地接住
    dragOrigin = petWin.getBounds();
    dragMoved = false;
  });
  ipcMain.on('pet:drag-move', (e, dx, dy) => {
    if (!trusted(e) || !petWin || !dragOrigin) return;
    if (!dragMoved) {
      dragMoved = true;
      hidePanel();
    }
    // 用 setBounds 固定宽高：高 DPI 下反复 setPosition 会让透明窗口越拖越大
    petWin.setBounds({
      x: Math.round(dragOrigin.x + Number(dx || 0)),
      y: Math.round(dragOrigin.y + Number(dy || 0)),
      width: dragOrigin.width,
      height: dragOrigin.height,
    });
  });
  ipcMain.on('pet:drag-end', (e, v) => {
    if (!trusted(e) || !petWin) return;
    endPetDrag();
    const fling = flingVelocity(v);
    logUi({ ev: 'release', fling: Boolean(fling) });
    if (!fling) return;
    // 页面已经摆出飞行动作：飞不了也要告诉它一声，让它恢复待机
    if (config.get().throwable === false || !startFlight(fling)) {
      sendTo(petWin, 'pet:motion', { kind: 'end', reason: 'refused', was: 'fly', impact: 0 });
    }
  });
  ipcMain.on('pet:wander', (e) => {
    if (!trusted(e)) return;
    // 自动化测试要按固定位置点宠物，不让它自己走开
    if (TEST_DIR || config.get().wander === false || !startWalk()) sendTo(petWin, 'pet:motion', { kind: 'refused' });
  });
  ipcMain.on('pet:motion-stop', (e) => {
    if (trusted(e) && motion && motion.kind === 'walk') stopMotion('hover');
  });
  ipcMain.on('pet:click', (e) => {
    if (!trusted(e)) return;
    logUi({ ev: 'click' });
    togglePanel();
  });
  ipcMain.on('pet:menu', (e) => {
    if (!trusted(e)) return;
    // 宠物窗口不可聚焦，借托盘的弹出方式（会把菜单设为前台），点别处时菜单才能正常收起
    if (tray) tray.popUpContextMenu(buildMenu());
    else buildMenu().popup({ window: petWin });
  });
  ipcMain.on('pet:icon', (e, dataUrl) => {
    if (!trusted(e) || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) return;
    const img = nativeImage.createFromDataURL(dataUrl);
    if (img.isEmpty()) return;
    petIconDataUrl = dataUrl;
    trayIconImage = img;
    if (tray) tray.setImage(img.resize({ width: 32, height: 32, quality: 'best' }));
    broadcast('pet:icon', dataUrl);
  });

  ipcMain.on('panel:resize', (e, h) => {
    if (!trusted(e)) return;
    panelHeight = Math.round(clampNum(h, 160, 1400, 460));
    placePanel();
  });
  ipcMain.on('panel:close', (e) => trusted(e) && hidePanel());

  ipcMain.handle('settings:save', (e, patch) => (trusted(e) ? updateConfig(sanitize(patch)) : null));
  ipcMain.handle('settings:autostart', (e, on) => {
    if (trusted(e)) setAutoStart(on);
    return getAutoStart();
  });
  ipcMain.handle('settings:rescan-pets', (e) => {
    if (trusted(e)) rescanPets();
    return fullState();
  });
  ipcMain.handle('settings:deepseek-key', async (e, rawKey) => {
    if (!trusted(e)) return null;
    const key = String(rawKey || '').trim();
    if (!key) return { ok: false, error: '请先填写 API Key' };
    try {
      const r = await deepseek.requestBalance(key, fetchImpl);
      config.setDeepseekKey(key);
      quota.refresh(['deepseek']);
      return { ok: true, balances: r.balances, available: r.available, config: publicConfig() };
    } catch (err) {
      if (err.code === 'unauthorized') return { ok: false, error: err.message };
      // 网络问题时先保存，等网络恢复自动生效
      config.setDeepseekKey(key);
      quota.refresh(['deepseek']);
      return { ok: true, warning: `已保存，但暂时没连上 DeepSeek：${err.message}`, config: publicConfig() };
    }
  });
  ipcMain.handle('settings:deepseek-key-clear', (e) => {
    if (!trusted(e)) return null;
    config.setDeepseekKey(null);
    quota.refresh(['deepseek']);
    return publicConfig();
  });
}

// ---------- 自检 / 截图（开发用） ----------

async function runSelftest() {
  const out = {
    pets: pets.map((p) => ({ id: p.id, name: p.displayName, rows: p.rows, size: `${p.width}x${p.height}`, mime: p.mime })),
    current: currentPet && currentPet.id,
  };
  for (const name of PROVIDERS) {
    const t0 = Date.now();
    try {
      const data = await quota.runners[name]();
      out[name] = { ok: true, ms: Date.now() - t0, data };
    } catch (e) {
      out[name] = { ok: false, ms: Date.now() - t0, error: e.message };
    }
  }
  const text = JSON.stringify(out, null, 2);
  const outFile = argValue('--out');
  if (outFile) fs.writeFileSync(outFile, text);
  process.stdout.write(`${text}\n`);
  app.exit(0);
}

async function capture(win, file) {
  if (!win || win.isDestroyed()) return;
  const img = await win.webContents.capturePage();
  fs.writeFileSync(file, img.toPNG());
}

// 在真实窗口中模拟系统通知，不实际锁定用户电脑，也不移动系统鼠标。
async function checkSessionRecovery() {
  const assert = require('node:assert/strict');
  const results = [];
  const wc = petWin.webContents;
  const scenarios = [
    ['lock-screen', 'unlock-screen'],
    ['suspend', 'resume'],
    ['lock-screen', 'suspend', 'resume', 'unlock-screen'],
    ['lock-screen', 'suspend', 'unlock-screen', 'resume'],
    // 系统漏发或乱序送达通知时，也不能一直当作“还在锁屏”。
    ['lock-screen'],
    ['suspend'],
    ['lock-screen', 'suspend', 'unlock-screen'],
    ['unlock-screen', 'lock-screen'],
    // 睡醒后一个通知都没有：靠心跳发现定时器停摆过。
    ['clock-gap'],
    ['display-metrics-changed'],
    ['display-removed', 'display-added', 'display-metrics-changed'],
    // 宠物页面的渲染进程没了：要自动重新加载。
    ['renderer-crash'],
    ['renderer-hang'],
  ];
  const input = (type, x, y, down = false) => {
    const b = petWin.getBounds();
    wc.sendInputEvent({
      type, x, y, globalX: b.x + x, globalY: b.y + y,
      button: 'left', clickCount: 1, modifiers: down ? ['leftButtonDown'] : [],
    });
  };
  for (const events of scenarios) {
    const displayMethods = ['getAllDisplays', 'getPrimaryDisplay', 'getDisplayNearestPoint'];
    const originals = Object.fromEntries(displayMethods.map((name) => [name, screen[name]]));
    let virtualDisplay = null;
    if (events.some((name) => name.startsWith('display-'))) {
      const d = screen.getPrimaryDisplay();
      virtualDisplay = { ...d,
        bounds: { ...d.bounds, width: Math.max(640, d.bounds.width - 500) },
        workArea: { ...d.workArea, width: Math.max(640, d.workArea.width - 500) },
      };
      // 只替换本测试进程看到的布局；不改 Windows 的实际分辨率。
      screen.getAllDisplays = () => [virtualDisplay];
      screen.getPrimaryDisplay = screen.getDisplayNearestPoint = () => virtualDisplay;
    }
    try {
      hidePanel();
      uiLog.length = 0;
      const b = petWin.getBounds();
      const x = Math.round(b.width / 2);
      const y = Math.round(b.height - petMetrics().spriteH * 0.45);
      sendTo(petWin, 'pet:cursor', { x, y });
      await sleep(60);
      // 故意不发 mouseUp，覆盖切换桌面时丢失松手事件的情况。
      input('mouseDown', x, y);
      input('mouseMove', x + 20, y, true);
      await sleep(60);
      for (const name of events) {
        if (name === 'clock-gap') {
          // 假装上一次心跳在 10 秒前，等下一次心跳发现停摆。
          lastBeat = { mono: lastBeat.mono - 10e3, wall: lastBeat.wall - 10e3 };
          await sleep(1200);
        } else if (name === 'renderer-crash' || name === 'renderer-hang') {
          let timeout;
          try {
            const reloaded = new Promise((resolve, reject) => {
              wc.once('did-finish-load', resolve);
              timeout = setTimeout(() => reject(new Error(`renderer recovery timed out: ${name}`)), 25000);
            });
            if (name === 'renderer-hang') {
              // 真实阻塞这个测试窗口的页面；依靠心跳超时结束进程并重载。
              wc.executeJavaScript('while (true) {}').catch(() => {});
            } else wc.forcefullyCrashRenderer();
            await reloaded;
          } finally { clearTimeout(timeout); }
          await sleep(1000); // 等页面读完状态、载入宠物图。
        } else if (name.startsWith('display-')) {
          screen.emit(name, {}, virtualDisplay, ['bounds', 'workArea', 'scaleFactor']);
        } else {
          powerMonitor.emit(name);
        }
        await sleep(60);
      }
      await sleep(1650); // 同时覆盖显示器布局稳定后的二次校准。
      assert.equal(dragOrigin, null, `session recovery must clear the main-process drag: ${events}`);
      if (virtualDisplay) {
        const b = petWin.getBounds();
        const wa = virtualDisplay.workArea;
        assert.ok(b.x >= wa.x && b.x + b.width <= wa.x + wa.width, 'pet must fit the reduced desktop');
      }
      assert.equal(uiLog.some((e) => e.ev === 'click'), false, `cancelled press must not open the panel: ${events}`);
      input('mouseUp', x, y); // 清理 Chromium 的合成按钮状态。
      await sleep(60);
      assert.equal(panelWin.isVisible(), false, `late mouseUp must not open the panel: ${events}`);
      sendTo(petWin, 'pet:cursor', { x, y });
      await sleep(60);
      const before = petWin.getBounds();
      input('mouseDown', x, y);
      input('mouseMove', x - 24, y, true);
      await sleep(80);
      input('mouseUp', x, y);
      await sleep(80);
      const dx = petWin.getBounds().x - before.x;
      assert.equal(dx, -24, `dragging must work after session recovery: ${events}`);
      input('mouseDown', x, y);
      input('mouseUp', x, y);
      await sleep(160);
      assert.equal(panelWin.isVisible(), true, `click must open the quota panel after session recovery: ${events}`);
      results.push({ events, dragDx: dx, panelVisibleAfterClick: true });
    } finally {
      for (const name of displayMethods) screen[name] = originals[name];
    }
  }
  hidePanel();
  const c = petWin.getBounds();
  const atPet = { x: Math.round(c.width / 2), y: Math.round(c.height - petMetrics().spriteH * 0.45) };
  sendTo(petWin, 'pet:cursor', atPet);
  await sleep(60);
  // 故意使原生穿透与页面缓存不一致；验证静止鼠标时也会重发原生设置。
  petWin.setIgnoreMouseEvents(true, { forward: true });
  uiLog.length = 0;
  sendTo(petWin, 'pet:cursor', { ...atPet, forceHitTest: true });
  await sleep(60);
  assert.ok(uiLog.some((e) => e.ev === 'ignore' && e.value === false), 'native hit test drift must be repaired');
  setPetHidden(true);
  powerMonitor.emit('lock-screen');
  powerMonitor.emit('unlock-screen');
  await sleep(1650);
  assert.equal(petWin.isVisible(), false, 'session recovery must respect the hidden-pet setting');
  setPetHidden(false);
  return { scenarios: results, hiddenPetStayedHidden: true, nativeHitTestResynchronized: true };
}

// 用合成事件把宠物甩出去（不碰真实鼠标）：要飞起来、落在任务栏上，落地后照样能点开面板；
// 再甩一次、半空中按住，应该被接住，松手也不开面板。
async function checkThrow() {
  const assert = require('node:assert/strict');
  const wc = petWin.webContents;
  if (await wc.executeJavaScript("matchMedia('(prefers-reduced-motion: reduce)').matches")) {
    return { skipped: '系统关闭了动画效果，宠物不会被甩出去' };
  }
  const original = petWin.getBounds();
  const m = petMetrics();
  const grip = () => {
    const b = petWin.getBounds();
    return { b, x: Math.round(b.width / 2), y: Math.round(b.height - m.spriteH * 0.45) };
  };
  // 真实拖动时窗口跟着鼠标走，鼠标相对窗口的位置不变；只有屏幕坐标在变。
  // 要是相对坐标也跟着挪，几步之后就落到窗口外面，合成事件会被丢掉。
  const input = (type, g, dx = 0, dy = 0, down = false) => wc.sendInputEvent({
    type, x: g.x, y: g.y, globalX: g.b.x + g.x + dx, globalY: g.b.y + g.y + dy,
    button: 'left', clickCount: 1, modifiers: down ? ['leftButtonDown'] : [],
  });
  const fling = async (vx, vy) => {
    hidePanel();
    const g = grip();
    sendTo(petWin, 'pet:cursor', { x: g.x, y: g.y });
    await sleep(80);
    input('mouseDown', g);
    for (let i = 1; i <= 6; i++) {
      input('mouseMove', g, i * vx, i * vy, true);
      await sleep(12);
    }
    input('mouseUp', g, 6 * vx, 6 * vy);
    await sleep(40);
  };
  const waitLanding = async () => {
    const trail = [];
    for (let t = 0; t < 12000 && motion; t += 50) {
      trail.push(petWin.getBounds());
      await sleep(50);
    }
    return trail;
  };

  // 往左上甩：每 12ms 挪 36px（约 3000 px/s），应该先往左上飞，最后脚踩任务栏
  uiLog.length = 0;
  await fling(-36, -14);
  assert.equal(motion && motion.kind, 'fly', `a fast release must start a flight: ${JSON.stringify(uiLog.slice(-8))}`);
  const trail = await waitLanding();
  assert.equal(motion, null, 'the pet must come to rest');
  const b = petWin.getBounds();
  const body = petBody(b, m);
  const wa = screen.getDisplayNearestPoint({ x: Math.round(body.x + body.w / 2), y: Math.round(body.y + body.h / 2) }).workArea;
  // 缩放屏幕上 getBounds 换算回 DIP 会有 1px 的取整误差
  assert.ok(Math.abs(body.y + body.h - (wa.y + wa.height)) <= 2, `it lands on the taskbar: ${body.y + body.h} vs ${wa.y + wa.height}`);
  assert.ok(body.x >= wa.x - 2 && body.x + body.w <= wa.x + wa.width + 2, 'it stays on the screen');
  assert.ok(Math.min(...trail.map((p) => p.y)) < original.y, 'it flew upwards first');

  const g = grip();
  sendTo(petWin, 'pet:cursor', { x: g.x, y: g.y });
  await sleep(80);
  input('mouseDown', g);
  input('mouseUp', g);
  await sleep(200);
  assert.equal(panelWin.isVisible(), true, 'a landed pet still opens the panel');

  // 往上甩，飞到半空时按住：被接住，不再继续飞，松手也不开面板
  uiLog.length = 0;
  await fling(0, -40);
  await sleep(120);
  assert.equal(motion && motion.kind, 'fly', `a second fling must fly: ${JSON.stringify(uiLog.slice(-8))}`);
  const c = grip();
  input('mouseDown', c);
  await sleep(80);
  assert.equal(motion, null, 'pressing a flying pet catches it');
  const caughtAt = petWin.getBounds();
  input('mouseUp', c);
  await sleep(250);
  assert.equal(panelWin.isVisible(), false, 'releasing a caught pet must not open the panel');
  assert.deepEqual(petWin.getBounds(), caughtAt, 'a caught pet stays where it was caught');

  hidePanel();
  petWin.setBounds(original);
  sendEdge();
  return { landed: { x: b.x, y: b.y }, flightSamples: trail.length, lowestY: Math.min(...trail.map((p) => p.y)), caughtAt };
}

// 截一组新状态的图：额度回满、撸猫、睡着、回来汇报、贴着屏幕边的气泡
async function captureReactions(dir) {
  const real = quota.snapshot();
  const reset = JSON.parse(JSON.stringify(real));
  if (reset.codex && reset.codex.data) reset.codex.data.windows[0].usedPercent = 2;
  sendTo(petWin, 'quota:update', reset);
  await sleep(350);
  await capture(petWin, path.join(dir, 'pet-celebrate.png'));
  await sleep(7000);
  sendTo(petWin, 'quota:update', real);
  await sleep(10500); // 等告急气泡收起
  sendTo(petWin, 'pet:debug', { pet: true });
  await sleep(300);
  await capture(petWin, path.join(dir, 'pet-petted.png'));
  await sleep(2600);
  sendTo(petWin, 'pet:away', { away: true });
  await sleep(900);
  await capture(petWin, path.join(dir, 'pet-sleeping.png'));
  sendTo(petWin, 'pet:away', { away: false, awayMs: 95 * 60e3 });
  await sleep(3200);
  await capture(petWin, path.join(dir, 'pet-back-report.png'));
  await sleep(500);
  const b = petWin.getBounds();
  const wa = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height - 30 }).workArea;
  petWin.setBounds({ ...b, x: Math.round(wa.x - (b.width - petMetrics().spriteW) / 2) });
  sendEdge();
  sendTo(petWin, 'pet:debug', { summary: true });
  await sleep(400);
  await capture(petWin, path.join(dir, 'pet-edge-bubble.png'));
  petWin.setBounds(b);
  sendEdge();
  sendTo(petWin, 'pet:cursor', { x: 3, y: 3 });
  await sleep(400);
}

function watchRendererErrors(win) {
  const errors = [];
  win.webContents.on('console-message', (e, level, message) => {
    const lv = e && e.level !== undefined ? e.level : level;
    const msg = e && e.message !== undefined ? e.message : message;
    if (lv === 'error' || lv === 'warning' || lv === 3 || lv === 2) errors.push(String(msg));
  });
  return errors;
}

// 用合成事件走一遍交互（不碰真实鼠标）：悬停 → 穿透 → 看向 → 拖动 → 点击开面板
async function runSnapshot(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const report = {};
  const petErrors = watchRendererErrors(petWin);
  const mark = (name) => {
    report[name] = uiLog.splice(0);
  };
  await sleep(1200);
  await quota.refresh();
  await sleep(900);
  await capture(petWin, path.join(dir, 'pet-after-refresh.png'));
  await sleep(4000); // 等开场问候气泡消失

  const m = petMetrics();
  const b0 = petWin.getBounds();
  const cx = Math.round(b0.width / 2);
  const cy = Math.round(b0.height - m.spriteH * 0.45);
  uiLog.length = 0;
  sendTo(petWin, 'pet:cursor', { x: cx, y: cy });
  await sleep(400);
  mark('hoverPetCenter');
  sendTo(petWin, 'pet:cursor', { x: 3, y: 3 });
  await sleep(500);
  mark('moveToTransparentCorner');
  sendTo(petWin, 'pet:cursor', { x: cx - 340, y: cy - 30 });
  await sleep(300);
  await capture(petWin, path.join(dir, 'pet-look-left.png'));
  sendTo(petWin, 'pet:cursor', { x: cx + 340, y: cy + 160 });
  await sleep(300);
  await capture(petWin, path.join(dir, 'pet-look-down-right.png'));

  const wc = petWin.webContents;
  const gx = b0.x + cx;
  const gy = b0.y + cy;
  sendTo(petWin, 'pet:cursor', { x: cx, y: cy });
  await sleep(200);
  wc.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, globalX: gx, globalY: gy, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 8; i++) {
    wc.sendInputEvent({
      type: 'mouseMove', x: cx + i * 8, y: cy, globalX: gx + i * 8, globalY: gy,
      button: 'left', modifiers: ['leftButtonDown'],
    });
    await sleep(40);
  }
  await capture(petWin, path.join(dir, 'pet-dragging.png'));
  wc.sendInputEvent({ type: 'mouseUp', x: cx + 64, y: cy, globalX: gx + 64, globalY: gy, button: 'left', clickCount: 1 });
  await sleep(300);
  mark('dragRight');
  report.windowMovedBy = { dx: petWin.getBounds().x - b0.x, dy: petWin.getBounds().y - b0.y };
  petWin.setBounds(b0);

  sendTo(petWin, 'pet:cursor', { x: cx, y: cy });
  await sleep(200);
  wc.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, globalX: gx, globalY: gy, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, globalX: gx, globalY: gy, button: 'left', clickCount: 1 });
  await sleep(1800);
  mark('clickPet');
  report.panelVisibleAfterClick = Boolean(panelWin && panelWin.isVisible());
  await capture(panelWin, path.join(dir, 'panel.png'));
  sendTo(petWin, 'pet:cursor', { x: 3, y: 3 });
  sendTo(petWin, 'pet:debug', { summary: true });
  await sleep(700);
  await capture(petWin, path.join(dir, 'pet.png'));

  // 在面板里点“深色”，走一遍真实的切换路径；截完图恢复原来的主题
  const themeBefore = config.get().theme || 'system';
  await panelWin.webContents.executeJavaScript(`document.querySelector('#theme-seg [data-theme="dark"]').click()`);
  await sleep(900);
  report.themeAfterClick = {
    config: config.get().theme,
    themeSource: nativeTheme.themeSource,
    dark: nativeTheme.shouldUseDarkColors,
    activeButton: await panelWin.webContents.executeJavaScript(`document.querySelector('#theme-seg .on')?.dataset.theme`),
  };
  await capture(panelWin, path.join(dir, 'panel-dark.png'));
  sendTo(petWin, 'pet:debug', { summary: true });
  await sleep(500);
  await capture(petWin, path.join(dir, 'pet-dark.png'));
  report.bounds = { pet: petWin.getBounds(), panel: panelWin.getBounds(), workArea: screen.getPrimaryDisplay().workArea };

  openSettings();
  await sleep(2500);
  await capture(settingsWin, path.join(dir, 'settings-dark.png'));
  updateConfig({ theme: 'light' });
  await sleep(900);
  report.settingsLightBg = settingsWin.getBackgroundColor();
  await capture(settingsWin, path.join(dir, 'settings-light.png'));
  updateConfig({ theme: themeBefore });
  report.themeRestoredTo = config.get().theme;
  await captureReactions(dir);
  report.throw = await checkThrow();
  report.sessionRecovery = await checkSessionRecovery();
  report.rendererErrors = petErrors;
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  app.exit(0);
}

// ---------- 启动 ----------

async function start() {
  config = new Config(userFile('config.json'));
  applyTheme();
  nativeTheme.on('updated', () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.setBackgroundColor(windowBg());
  });
  loadPets();
  registerProtocol();
  await applyProxy();
  const runners = DEMO || INTERACTION_TEST_DIR ? require('./test/demo-data')() : makeRunners();
  quota = new QuotaService({ runners, isEnabled: (n) => config.get().providers[n] !== false });
  quota.on('update', onQuotaUpdate);
  if (SELFTEST) return runSelftest();

  registerIpc();
  // 不要 Electron 的默认菜单：它带着 Ctrl+加号/减号 缩放、Ctrl+R 重载、Ctrl+W 关窗等快捷键，
  // 面板有焦点时一按就会作用到我们的窗口上。
  Menu.setApplicationMenu(null);
  createPetWindow();
  createPanelWindow();
  createTray();
  if (!TEST_DIR) startCursorPolling();
  watchDisplays();
  watchPowerEvents();
  watchClockGaps();
  // 自动化测试按固定位置操作宠物，不能让它中途睡着
  if (!TEST_DIR) watchAway();
  logRecovery('started', { version: app.getVersion(), displays: screen.getAllDisplays().map((d) => ({
    id: d.id, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor,
  })) });
  scheduleRefresh();
  watchClaudeDesktop();
  setTimeout(() => quota.refresh(), 800);
  if (INTERACTION_TEST_DIR) {
    fs.mkdirSync(INTERACTION_TEST_DIR, { recursive: true });
    (async () => {
      const petErrors = watchRendererErrors(petWin);
      await sleep(1600);
      const report = await checkSessionRecovery();
      report.throw = await checkThrow();
      report.rendererErrors = petErrors;
      fs.writeFileSync(path.join(INTERACTION_TEST_DIR, 'report.json'), JSON.stringify(report, null, 2));
      app.exit(0);
    })().catch((err) => {
      fs.writeFileSync(path.join(INTERACTION_TEST_DIR, 'error.txt'), err.stack || String(err));
      console.error(err);
      app.exit(1);
    });
  } else if (SNAPSHOT_DIR) runSnapshot(SNAPSHOT_DIR).catch((err) => {
    console.error(err);
    app.exit(1);
  });
}

if (SELFTEST || TEST_DIR) {
  app.whenReady().then(start);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (config && config.get().petHidden) setPetHidden(false);
    if (quota) showPanel();
  });
  app.whenReady().then(start);
}

// 常驻托盘：关掉设置窗口不退出
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  clearInterval(refreshTimer);
  clearInterval(cursorTimer);
  clearInterval(heartbeatTimer);
  clearInterval(awayTimer);
  clearTimeout(petRefitTimer);
  clearTimeout(resumeRefreshTimer);
  clearTimeout(resetRefreshTimer);
  if (motion) clearInterval(motion.timer);
  fs.unwatchFile(DESKTOP_HISTORY_FILE);
});

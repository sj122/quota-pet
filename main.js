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

app.setPath('userData', path.join(app.getPath('appData'), 'quota-pet'));

const { Config } = require('./src/config');
const { JsonFile } = require('./src/store');
const { listPets } = require('./src/pets');
const { QuotaService, PROVIDERS } = require('./src/quota');
const { fetchCodex, findCodexExe } = require('./src/providers/codex');
const { fetchClaude, DESKTOP_HISTORY_FILE } = require('./src/providers/claude');
const deepseek = require('./src/providers/deepseek');
const QP = require('./renderer/shared');

const ROOT = __dirname;
const argValue = (name) => {
  const a = process.argv.find((x) => x.startsWith(`${name}=`));
  return a ? a.slice(name.length + 1) : null;
};
const SELFTEST = process.argv.includes('--selftest');
const SNAPSHOT_DIR = argValue('--snapshot');
const DEMO = process.argv.includes('--demo');

const PET_PAD_TOP = 84; // 宠物头顶留给气泡的高度
const PANEL_WIDTH = 372; // 含四周阴影留白
const PANEL_MARGIN = 14;
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
let panelHiddenAt = 0;
let panelHeight = 460;
let dragOrigin = null;
let dragMoved = false;
let refreshTimer = null;
let cursorTimer = null;

const userFile = (name) => path.join(app.getPath('userData'), name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uiLog = [];
const logUi = (ev) => {
  if (SNAPSHOT_DIR) uiLog.push(ev);
};

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
  if (!a || typeof a.cx !== 'number' || typeof a.bottom !== 'number') return false;
  return screen.getAllDisplays().some((d) => {
    const r = d.bounds;
    return a.cx >= r.x && a.cx <= r.x + r.width && a.bottom - 30 >= r.y && a.bottom - 30 <= r.y + r.height;
  });
}

function defaultAnchor(m) {
  const wa = screen.getPrimaryDisplay().workArea;
  return { cx: wa.x + wa.width - m.width / 2 - 36, bottom: wa.y + wa.height };
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
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};
const broadcast = (channel, payload) => [petWin, panelWin, settingsWin].forEach((w) => sendTo(w, channel, payload));

function createPetWindow() {
  const m = petMetrics();
  let anchor = config.get().position;
  if (!anchorVisible(anchor)) anchor = defaultAnchor(m);
  petWin = new BrowserWindow({
    ...boundsFromAnchor(anchor, m),
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
  panelWin.on('blur', () => {
    if (!SNAPSHOT_DIR) hidePanel();
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
  placePanel();
  panelWin.show();
  panelWin.focus();
  sendTo(petWin, 'panel:visible', true);
  if (quota.staleness() > 60e3) quota.refresh();
  else quota.refresh(['claude'], { silent: true });
}

function hidePanel() {
  if (!panelWin || panelWin.isDestroyed() || !panelWin.isVisible()) return;
  panelHiddenAt = Date.now();
  panelWin.hide();
  sendTo(petWin, 'panel:visible', false);
}

function togglePanel() {
  if (panelWin && !panelWin.isDestroyed() && panelWin.isVisible()) return hidePanel();
  // 点宠物时面板可能先因失焦被收起，这里避免紧接着又弹出来
  if (Date.now() - panelHiddenAt < 300) return;
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
      label: '眼睛跟着鼠标',
      type: 'checkbox',
      checked: cfg.eyeFollow,
      enabled: Boolean(currentPet && currentPet.hasLookFrames),
      click: (item) => updateConfig({ eyeFollow: item.checked }),
    },
    {
      label: '闲着时做小动作',
      type: 'checkbox',
      checked: cfg.idleSelfPlay,
      click: (item) => updateConfig({ idleSelfPlay: item.checked }),
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
  const m = petMetrics();
  petWin.setBounds(boundsFromAnchor(anchorFromBounds(petWin.getBounds()), m));
  sendTo(petWin, 'pet:changed', { pet: petInfo(), metrics: m, config: publicConfig() });
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
  for (const k of ['idleSelfPlay', 'eyeFollow']) if (k in patch) out[k] = Boolean(patch[k]);
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
  refreshTimer = setInterval(() => quota.refresh(), mins * 60e3);
}

function watchClaudeDesktop() {
  fs.watchFile(DESKTOP_HISTORY_FILE, { interval: 15000 }, (cur, prev) => {
    if (cur.mtimeMs !== prev.mtimeMs) quota.refresh(['claude'], { silent: true });
  });
}

// 渲染进程拿不到窗口外的鼠标位置，由主进程轮询后转发（用于眼睛跟随和穿透判断）
function startCursorPolling() {
  let last = '';
  cursorTimer = setInterval(() => {
    if (!petWin || petWin.isDestroyed() || !petWin.isVisible()) return;
    const p = screen.getCursorScreenPoint();
    const b = petWin.getBounds();
    const key = `${p.x},${p.y},${b.x},${b.y}`;
    if (key === last) return;
    last = key;
    petWin.webContents.send('pet:cursor', { x: p.x - b.x, y: p.y - b.y });
  }, 50);
}

function onQuotaUpdate(snap) {
  broadcast('quota:update', snap);
  if (tray) tray.setToolTip(['额度桌宠', ...QP.summaryLines(snap)].join('\n').slice(0, 127));
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
  ipcMain.on('pet:drag-start', (e) => {
    if (!trusted(e) || !petWin) return;
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
  ipcMain.on('pet:drag-end', (e) => {
    if (!trusted(e) || !petWin) return;
    if (dragMoved) {
      logUi({ ev: 'drag', dx: petWin.getBounds().x - dragOrigin.x, dy: petWin.getBounds().y - dragOrigin.y });
      if (!SNAPSHOT_DIR) config.set({ position: anchorFromBounds(petWin.getBounds()) });
    }
    dragOrigin = null;
    dragMoved = false;
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

// 用合成事件走一遍交互（不碰真实鼠标）：悬停 → 穿透 → 看向 → 拖动 → 点击开面板
async function runSnapshot(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const report = {};
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
    wc.sendInputEvent({ type: 'mouseMove', x: cx + i * 8, y: cy, globalX: gx + i * 8, globalY: gy, button: 'left' });
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
  const runners = DEMO ? require('./test/demo-data')() : makeRunners();
  quota = new QuotaService({ runners, isEnabled: (n) => config.get().providers[n] !== false });
  quota.on('update', onQuotaUpdate);
  if (SELFTEST) return runSelftest();

  registerIpc();
  createPetWindow();
  createPanelWindow();
  createTray();
  if (!SNAPSHOT_DIR) startCursorPolling();
  scheduleRefresh();
  watchClaudeDesktop();
  powerMonitor.on('resume', () => setTimeout(() => quota.refresh(), 5000));
  setTimeout(() => quota.refresh(), 800);
  if (SNAPSHOT_DIR) runSnapshot(SNAPSHOT_DIR);
}

if (SELFTEST || SNAPSHOT_DIR) {
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
  fs.unwatchFile(DESKTOP_HISTORY_FILE);
});

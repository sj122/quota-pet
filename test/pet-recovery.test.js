'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

// Execute the actual main process handlers; only Electron, clocks and disk writes are replaced.
function createMain() {
  const timers = new Map();
  const intervals = new Map();
  const records = [];
  let clock = 100000;
  let id = 0;
  const display = { id: 1, scaleFactor: 1.25,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
  const screen = Object.assign(new EventEmitter(), {
    getAllDisplays: () => [display], getPrimaryDisplay: () => display,
    getDisplayNearestPoint: () => display,
    getCursorScreenPoint: () => ({ x: 1800, y: 980 }),
    dipToScreenPoint: (p) => ({ x: p.x * 1.25, y: p.y * 1.25 }),
    dipToScreenRect: (_w, b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v * 1.25])),
  });
  const power = Object.assign(new EventEmitter(), { getSystemIdleState: () => 'active' });
  const app = Object.assign(new EventEmitter(), {
    getPath: () => 'test-profile', setPath() {}, requestSingleInstanceLock: () => true,
    whenReady: () => ({ then() {} }), getLoginItemSettings: () => ({ openAtLogin: false }),
  });
  const ipc = Object.assign(new EventEmitter(), { handle() {} });
  const wc = Object.assign(new EventEmitter(), {
    sent: [], crashed: false, loading: false, crashes: 0,
    isDestroyed: () => false, isCrashed() { return this.crashed; },
    isLoadingMainFrame() { return this.loading; },
    send(channel, payload) { this.sent.push({ channel, payload }); }, setZoomLevel() {},
    forcefullyCrashRenderer() { this.crashes++; this.crashed = true; },
  });
  const pet = Object.assign(new EventEmitter(), {
    bounds: { x: 1660, y: 832, width: 260, height: 208 }, visible: true,
    ignoring: true, reloads: 0, dead: false, webContents: wc,
    focusable: false, skipTaskbar: true, focused: false,
    isDestroyed() { return this.dead; }, isVisible() { return this.visible; },
    getBounds() { return { ...this.bounds }; }, setBounds(b) { this.bounds = { ...b }; },
    setIgnoreMouseEvents(value) { this.ignoring = value; }, setAlwaysOnTop() {},
    setFocusable(value) { this.focusable = value; this.skipTaskbar = !value; },
    setSkipTaskbar(value) { this.skipTaskbar = value; },
    focus() { this.focused = true; },
    showInactive() { this.visible = true; }, getTitle: () => 'QuotaPet',
    reload() { this.reloads++; wc.crashed = false; },
  });
  const config = { data: { scale: 0.6, petHidden: false, position: { cx: 1900, bottom: 1040 } },
    get() { return this.data; }, set(p) { Object.assign(this.data, p); } };
  const mainFile = path.join(__dirname, '../main.js');
  const realRequire = createRequire(mainFile);
  const electron = { app, screen, powerMonitor: power, ipcMain: ipc,
    protocol: { registerSchemesAsPrivileged() {} }, Menu: {}, nativeTheme: {} };
  const context = vm.createContext({
    __dirname: path.dirname(mainFile), console, URL, Buffer,
    process: { argv: ['electron', '.'], platform: 'win32' },
    performance: { now: () => clock }, Date: class extends Date { static now() { return clock; } },
    setTimeout: (cb, delay) => { timers.set(++id, { cb, delay }); return id; },
    clearTimeout: (key) => timers.delete(key),
    setInterval: (cb, delay) => { intervals.set(delay, cb); return delay; }, clearInterval() {},
    require: (name) => name === 'electron' ? electron : name === 'fs' ? {
      mkdirSync() {}, existsSync: () => false, appendFileSync: (_p, s) => records.push(JSON.parse(s)),
    } : realRequire(name),
  });
  vm.runInContext(`${fs.readFileSync(mainFile, 'utf8')}
    globalThis.api = {
      setup(c, p) { config = c; petWin = p; quota = { refresh() {} }; lastPetHeartbeat = performance.now(); },
      watchDisplays, watchPowerEvents, watchClockGaps, checkPetHeartbeat, startCursorPolling,
      registerIpc, endPetDrag, schedulePetRefit, restorePetInteraction, reloadOnCrash,
      applyPassthrough, cursorInPet, probePetRenderer, checkCursorChannel,
      get dragging() { return dragOrigin; }, get heartbeat() { return lastPetHeartbeat; },
      get ignoring() { return passthroughIgnoring; }, get hitMap() { return hitMap; },
      get over() { return rendererOver; }
    };`, context);
  const api = context.api;
  api.setup(config, pet);
  api.registerIpc();
  const event = { senderFrame: { url: 'qp://app/renderer/pet.html' }, sender: wc };
  return { api, display, pet, wc, ipc, power, records, config, screen, event,
    advance(ms) { clock += ms; },
    runInterval(delay) { intervals.get(delay)(); },
    runTimer(delay) {
      const entry = [...timers].find(([, t]) => t.delay === delay);
      assert.ok(entry, `Expected an active ${delay}ms timer`);
      timers.delete(entry[0]); entry[1].cb();
    },
  };
}

test('display change cancels an orphaned drag and fits the whole window to the reduced work area', () => {
  const h = createMain();
  h.api.watchDisplays();
  h.ipc.emit('pet:drag-start', h.event);
  h.display.bounds.width = 1280;
  h.display.workArea.width = 1280;
  h.screen.emit('display-metrics-changed', {}, h.display, ['bounds', 'scaleFactor']);
  assert.equal(h.api.dragging, null);
  assert.ok(h.wc.sent.some((s) => s.channel === 'pet:interaction-reset'));
  h.runTimer(1500);
  const b = h.pet.bounds;
  assert.ok(b.x >= 0 && b.x + b.width <= 1280);
  assert.ok(b.y >= 0 && b.y + b.height <= 1040);
  assert.equal(h.config.data.position.cx, 1900, 'temporary resolution must not overwrite saved position');
});

test('a saved anchor near the edge keeps the complete pet in the work area', () => {
  const h = createMain();
  h.display.workArea = { x: -1280, y: 40, width: 1280, height: 680 };
  h.display.bounds = { x: -1280, y: 0, width: 1280, height: 720 };
  h.config.data.position = { cx: -5, bottom: 740 };
  h.api.restorePetInteraction();
  const b = h.pet.bounds;
  assert.ok(b.x >= -1280 && b.x + b.width <= 0);
  assert.ok(b.y >= 40 && b.y + b.height <= 720);
});

test('Windows recovery permits click activation without taking focus or adding a taskbar button', () => {
  const h = createMain();
  h.api.restorePetInteraction();
  assert.equal(h.pet.focusable, true, 'a no-activate window can lose mouseDown after remote session changes');
  assert.equal(h.pet.skipTaskbar, true, 'setFocusable must not expose a pet taskbar button');
  assert.equal(h.pet.focused, false, 'recovery must leave the user in their active application');
});

test('a new drag delays the pending display fit without losing it', () => {
  const h = createMain();
  h.api.schedulePetRefit();
  h.ipc.emit('pet:drag-start', h.event);
  h.runTimer(1500);
  assert.ok(h.api.dragging);
  h.api.endPetDrag();
  h.runTimer(1500);
  assert.equal(h.pet.bounds.x + h.pet.bounds.width, 1920);
});

// 当前帧的透明度图：48x52（192/4 x 208/4），只有 (col=5,row=10) 一个不透明像素。
const hitMapPayload = (overrides = {}) => {
  const alpha = new Uint8Array(48 * 52);
  alpha[10 * 48 + 5] = 255;
  return {
    cell: { row: 0, col: 0 },
    cellW: 192, cellH: 208, q: 4, cols: 48, rows: 52, alpha,
    sprite: { left: 70, top: 84, width: 120, height: 125 },
    viewport: { w: 260, h: 208 },
    ...overrides,
  };
};
// 精灵里的不透明像素换算回窗口像素（与页面里 hitPet 的换算方向相反）。
const windowPointOfOpaquePixel = { x: 70 + (5.5 / 48) * 120, y: 84 + (10.5 / 52) * 125 };
const windowPointOfTransparentPixel = { x: 70 + (30 / 48) * 120, y: 84 + (40 / 52) * 125 };

test('missing unlock/resume notifications cannot permanently block cursor polling or dragging', () => {
  const h = createMain();
  h.api.watchPowerEvents(); h.api.startCursorPolling();
  h.power.emit('lock-screen'); h.power.emit('suspend');
  h.ipc.emit('pet:drag-start', h.event);
  assert.ok(h.api.dragging);
  assert.equal(h.pet.ignoring, false, 'holding the button must keep the window interactive');
  h.runInterval(50);
  assert.ok(h.wc.sent.some((s) => s.channel === 'pet:cursor'));
});

test('main process hit tests the uploaded mask, so a wedged page cannot deafen the pet', () => {
  const h = createMain();
  h.ipc.emit('pet:hit-map', h.event, hitMapPayload());
  assert.ok(h.api.hitMap, 'the hit map must be accepted');
  h.api.applyPassthrough({ ...windowPointOfOpaquePixel, w: 260, h: 208 });
  assert.equal(h.pet.ignoring, false, 'opaque pixels must catch the mouse');
  h.api.applyPassthrough({ ...windowPointOfTransparentPixel, w: 260, h: 208 });
  assert.equal(h.pet.ignoring, true, 'transparent pixels inside the sprite must pass clicks through');
  h.api.applyPassthrough({ x: 5, y: 5, w: 260, h: 208 });
  assert.equal(h.pet.ignoring, true);
});

test('an oversized or malformed hit map is rejected instead of trusted', () => {
  const h = createMain();
  h.ipc.emit('pet:hit-map', h.event, hitMapPayload({ alpha: new Uint8Array(4) }));
  assert.equal(h.api.hitMap, null);
  h.ipc.emit('pet:hit-map', h.event, hitMapPayload({ cellW: 0 }));
  assert.equal(h.api.hitMap, null);
  h.ipc.emit('pet:hit-map', h.event, hitMapPayload());
  assert.ok(h.api.hitMap);
});

test('a visible bubble keeps the window interactive above the sprite', () => {
  const h = createMain();
  h.ipc.emit('pet:hit-map', h.event, hitMapPayload());
  h.ipc.emit('pet:hit-bubble', h.event, { left: 0, top: 0, width: 260, height: 60 });
  h.api.applyPassthrough({ x: 130, y: 30, w: 260, h: 208 });
  assert.equal(h.pet.ignoring, false);
  h.ipc.emit('pet:hit-bubble', h.event, null);
  h.api.applyPassthrough({ x: 130, y: 30, w: 260, h: 208 });
  assert.equal(h.pet.ignoring, true);
});

test('cursor channel stalls are detected and trigger a self-heal', () => {
  const h = createMain(); h.api.startCursorPolling(); h.api.watchClockGaps();
  h.advance(1000); h.runInterval(1000); // 初始化光标应答时间
  // 页面还在发心跳，但不再处理鼠标消息；按秒推进，避免走成“系统睡过”的分支。
  for (let i = 0; i < 15; i++) {
    h.ipc.emit('pet:heartbeat', h.event);
    h.advance(1000);
    h.runInterval(1000);
  }
  assert.ok(h.records.some((r) => r.event === 'cursor-channel-stalled'), 'a stalled cursor channel must be logged');
  assert.ok(h.records.some((r) => r.event === 'reactivate' && r.reason === 'cursor-stall'));
});

test('recovery probe resolves only when the page answers', async () => {
  const h = createMain();
  const pending = h.api.probePetRenderer();
  const sent = h.wc.sent.filter((s) => s.channel === 'pet:probe').at(-1);
  assert.ok(sent, 'the probe must be delivered to the page');
  h.ipc.emit('pet:probe-ack', h.event, sent.payload);
  assert.equal(await pending, true);
  const failing = h.api.probePetRenderer(50);
  h.runTimer(50);
  assert.equal(await failing, false, 'an unanswered probe must fail');
});

test('native hit testing is reasserted once per second even during continuous cursor movement', () => {
  const h = createMain(); h.api.startCursorPolling();
  for (let i = 0; i < 50; i++) {
    h.pet.bounds.x += 1; h.advance(50); h.runInterval(50);
  }
  const forced = h.wc.sent.filter((s) => s.payload.forceHitTest);
  assert.equal(forced.length, 3);
});

test('a timer gap recovers interaction without mistaking the sleeping renderer for a hung one', () => {
  const h = createMain(); h.api.watchClockGaps();
  h.ipc.emit('pet:drag-start', h.event);
  h.advance(60000); h.runInterval(1000);
  assert.equal(h.api.dragging, null);
  assert.equal(h.wc.crashes, 0);
  assert.ok(h.records.some((r) => r.reason === 'clock-gap'));
});

test('watchdog reloads a silent pet, but accepts liveness only from the pet renderer', () => {
  const h = createMain();
  h.advance(14000);
  h.ipc.emit('pet:heartbeat', { ...h.event, sender: {} });
  assert.equal(h.api.heartbeat, 100000);
  h.api.checkPetHeartbeat(114000);
  assert.equal(h.wc.crashes, 0);
  h.ipc.emit('pet:heartbeat', h.event);
  h.api.checkPetHeartbeat(115001);
  assert.equal(h.wc.crashes, 0);
  h.api.checkPetHeartbeat(129001);
  assert.equal(h.wc.crashes, 1);
});

test('hidden and locked desktops do not trigger a false renderer restart', () => {
  const h = createMain();
  h.pet.visible = false; h.api.checkPetHeartbeat(200000);
  h.pet.visible = true; h.power.getSystemIdleState = () => 'locked';
  h.api.checkPetHeartbeat(300000);
  assert.equal(h.wc.crashes, 0);
});

test('renderer crash reload is deduplicated and cancelled when its window closes', () => {
  const h = createMain(); h.api.reloadOnCrash(h.pet);
  h.wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  h.wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  h.runTimer(1000);
  assert.equal(h.pet.reloads, 1);
  h.wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  h.pet.emit('closed');
  assert.throws(() => h.runTimer(1000), /Expected an active/);
});

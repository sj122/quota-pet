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
    isDestroyed() { return this.dead; }, isVisible() { return this.visible; },
    getBounds() { return { ...this.bounds }; }, setBounds(b) { this.bounds = { ...b }; },
    setIgnoreMouseEvents(value) { this.ignoring = value; }, setAlwaysOnTop() {},
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
      get dragging() { return dragOrigin; }, get heartbeat() { return lastPetHeartbeat; }
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

test('missing unlock/resume notifications cannot permanently block cursor polling or dragging', () => {
  const h = createMain();
  h.api.watchPowerEvents(); h.api.startCursorPolling();
  h.power.emit('lock-screen'); h.power.emit('suspend');
  h.ipc.emit('pet:drag-start', h.event);
  assert.ok(h.api.dragging);
  h.ipc.emit('pet:ignore-mouse', h.event, false);
  assert.equal(h.pet.ignoring, false);
  h.runInterval(50);
  assert.ok(h.wc.sent.some((s) => s.channel === 'pet:cursor'));
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

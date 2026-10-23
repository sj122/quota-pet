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
  const power = Object.assign(new EventEmitter(), { getSystemIdleState: () => 'active', getSystemIdleTime: () => 0 });
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
      setup(c, p) {
        config = c; petWin = p; lastPetHeartbeat = performance.now();
        quota = { calls: [], refresh(names) { this.calls.push(names || 'all'); }, staleness: () => 0, lastRefreshAt: 0 };
      },
      startWalk, checkAway, scheduleResetRefresh,
      get motion() { return motion; }, get quota() { return quota; },
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
    now: () => clock,
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

// ---------- 甩出去、散步、离开 ----------

// main.js 在 vm 里运行，造出来的对象原型和测试这边不同；比较前先转成普通对象
const plain = (v) => JSON.parse(JSON.stringify(v));
const motions = (h) => plain(h.wc.sent.filter((s) => s.channel === 'pet:motion').map((s) => s.payload));

function fling(h, v, drag = [-40, -300]) {
  h.ipc.emit('pet:drag-start', h.event);
  h.ipc.emit('pet:drag-move', h.event, ...drag);
  h.ipc.emit('pet:drag-end', h.event, v);
}

function runMotion(h, maxSteps = 3000) {
  let n = 0;
  for (; n < maxSteps && h.api.motion; n++) {
    h.advance(16);
    h.runInterval(16);
  }
  return n;
}

test('a fling flies, bounces off the screen edge and lands on the taskbar inside the work area', () => {
  const h = createMain();
  fling(h, { vx: 2600, vy: -900 });
  assert.equal(h.api.motion.kind, 'fly');
  const steps = runMotion(h);
  assert.equal(h.api.motion, null, `still flying after ${steps} steps`);
  const b = h.pet.bounds;
  const left = b.x + (b.width - 115) / 2;
  assert.equal(b.y + b.height, 1040, 'feet on the taskbar');
  assert.ok(left >= -0.5 && left + 115 <= 1920.5, `body inside the work area: ${left}`);
  const m = motions(h);
  assert.equal(m[0].kind, 'fly');
  assert.ok(m.some((x) => x.kind === 'impact' && x.side === 'right'));
  assert.ok(m.some((x) => x.kind === 'impact' && x.side === 'floor'));
  assert.equal(m.at(-1).kind, 'end');
  assert.equal(m.at(-1).reason, 'land');
  assert.ok(m.at(-1).impact > 300);
  assert.deepEqual(plain(h.config.data.position), { cx: b.x + b.width / 2, bottom: 1040 }, 'the landing spot becomes home');
  assert.ok(h.wc.sent.some((s) => s.channel === 'pet:edge'));
});

test('grabbing the pet mid-flight catches it where it is', () => {
  const h = createMain();
  fling(h, { vx: -1500, vy: -700 }, [-300, -400]);
  for (let i = 0; i < 10; i++) {
    h.advance(16);
    h.runInterval(16);
  }
  const mid = { ...h.pet.bounds };
  h.ipc.emit('pet:drag-start', h.event);
  assert.equal(h.api.motion, null);
  assert.ok(h.api.dragging);
  h.advance(16);
  h.runInterval(16);
  assert.deepEqual(h.pet.bounds, mid);
  assert.equal(motions(h).at(-1).reason, 'catch');
});

test('display changes and locking ground a flying pet', () => {
  for (const trigger of ['display', 'lock']) {
    const h = createMain();
    h.api.watchDisplays();
    h.api.watchPowerEvents();
    fling(h, { vx: 1800, vy: -1200 });
    h.advance(16);
    h.runInterval(16);
    if (trigger === 'display') h.screen.emit('display-metrics-changed', {}, h.display, ['workArea']);
    else h.power.emit('lock-screen');
    assert.equal(h.api.motion, null, trigger);
    assert.equal(motions(h).at(-1).reason, 'reset', trigger);
  }
});

test('slow, malformed or disabled throws leave the pet where it was put down', () => {
  const h = createMain();
  fling(h, { vx: 120, vy: 0 });
  fling(h, { vx: 'fast', vy: 1 });
  fling(h, null);
  assert.equal(h.api.motion, null);
  assert.equal(motions(h).length, 0);
  h.config.data.throwable = false;
  fling(h, { vx: 3000, vy: 0 });
  assert.equal(h.api.motion, null);
  assert.deepEqual(motions(h).at(-1), { kind: 'end', reason: 'refused', was: 'fly', impact: 0 });
});

test('walking stays on the taskbar near home and never rewrites the saved home', () => {
  const h = createMain();
  h.config.data.position = { cx: 1000, bottom: 1040 };
  h.pet.bounds = { x: 870, y: 831, width: 260, height: 209 };
  for (let n = 0; n < 25; n++) {
    assert.equal(h.api.startWalk(), true, `walk ${n}`);
    runMotion(h);
    const b = h.pet.bounds;
    assert.equal(b.y + b.height, 1040);
    assert.ok(Math.abs(b.x + b.width / 2 - 1000) <= 288.5, `wandered too far: ${b.x}`);
  }
  assert.deepEqual(plain(h.config.data.position), { cx: 1000, bottom: 1040 });
  assert.ok(motions(h).every((m) => m.kind === 'walk' || m.reason === 'arrived'));
});

test('a pet put down above the taskbar stays put, and hovering stops a walk', () => {
  const h = createMain();
  h.pet.bounds = { x: 870, y: 500, width: 260, height: 209 };
  assert.equal(h.api.startWalk(), false);
  h.ipc.emit('pet:wander', h.event);
  assert.deepEqual(motions(h).at(-1), { kind: 'refused' });
  h.pet.bounds = { x: 870, y: 831, width: 260, height: 209 };
  assert.equal(h.api.startWalk(), true);
  h.ipc.emit('pet:motion-stop', h.event);
  assert.equal(h.api.motion, null);
  assert.equal(motions(h).at(-1).reason, 'hover');
});

test('away: sleeps after five idle minutes, ignores the lock screen, and reports the time away', () => {
  const h = createMain();
  const away = () => plain(h.wc.sent.filter((s) => s.channel === 'pet:away').map((s) => s.payload));
  let idle = 299;
  h.power.getSystemIdleTime = () => idle;
  h.api.checkAway();
  assert.equal(away().length, 0);
  idle = 300;
  h.api.checkAway();
  assert.deepEqual(away(), [{ away: true }]);
  h.advance(3600e3);
  idle = 1;
  h.power.getSystemIdleState = () => 'locked'; // 锁屏界面上输密码不算回来
  h.api.checkAway();
  assert.equal(away().length, 1);
  h.power.getSystemIdleState = () => 'active';
  h.api.checkAway();
  assert.deepEqual(away().at(-1), { away: false, awayMs: 3900e3 });
});

test('turning sleep off wakes the pet without a report', () => {
  const h = createMain();
  h.power.getSystemIdleTime = () => 900;
  h.api.checkAway();
  h.config.data.sleepWhenAway = false;
  h.api.checkAway();
  const away = plain(h.wc.sent.filter((s) => s.channel === 'pet:away').map((s) => s.payload));
  assert.deepEqual(away, [{ away: true }, { away: false, silent: true }]);
});

test('a refresh is scheduled just after the nearest quota window resets', () => {
  const h = createMain();
  const now = h.now();
  h.api.scheduleResetRefresh({
    codex: { status: 'ok', data: { windows: [{ key: 'primary', resetsAt: now + 10 * 60e3 }, { key: 'secondary', resetsAt: now + 3 * 86400e3 }] } },
    claude: { status: 'ok', data: { windows: [{ key: 'five_hour', resetsAt: now + 10 * 60e3 + 30e3 }] } },
  });
  h.runTimer(10 * 60e3 + 15e3);
  assert.deepEqual(plain(h.api.quota.calls), [['codex', 'claude']]);
  const far = createMain();
  far.api.scheduleResetRefresh({ codex: { status: 'ok', data: { windows: [{ key: 'secondary', resetsAt: now + 3 * 86400e3 }] } } });
  assert.throws(() => far.runTimer(3 * 86400e3 + 15e3), /Expected an active/);
});

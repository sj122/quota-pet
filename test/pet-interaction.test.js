'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const QP = require('../renderer/shared');
const QPPhysics = require('../renderer/physics');

// Run the actual renderer with controlled animation timers and sprite alpha pixels.
async function createPet({ opaque = () => true, captureThrows = false, spriteRect, viewport = {} } = {}) {
  const timers = new Map();
  const intervals = new Map();
  const subscriptions = {};
  const calls = {
    starts: 0, ends: 0, clicks: 0, heartbeats: 0, acks: 0, probeAcks: 0, wanders: 0, motionStops: 0,
    moves: [], released: [], ignores: [], hitMaps: [], bubbles: [], flings: [],
  };
  let timerId = 0;
  let ignoring = true; // Initial native BrowserWindow state.
  function element(rect) {
    const events = new Map();
    const classes = new Set();
    return {
      style: { setProperty() {} }, dataset: {}, hidden: false, children: [],
      appendChild(child) { this.children.push(child); },
      remove() {},
      classList: {
        add: (name) => classes.add(name), remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
      },
      addEventListener(type, cb) {
        if (!events.has(type)) events.set(type, []);
        events.get(type).push(cb);
      },
      dispatch(type, event = {}) {
        for (const cb of events.get(type) || []) cb(event);
      },
      getBoundingClientRect: () => rect,
      setPointerCapture() { if (captureThrows) throw new Error('Pointer is no longer active'); },
      releasePointerCapture(id) { calls.released.push(id); },
    };
  }
  const sprite = element(spriteRect || { left: 70, top: 84, right: 190, bottom: 209, width: 120, height: 125 });
  const bubble = element({ left: 0, top: 0, right: 260, bottom: 60, width: 260, height: 60 });
  bubble.hidden = true;
  const badge = element({});
  const fx = element({});
  const elements = { sprite, bubble, badge, fx };
  const window = Object.assign(element({}), viewport);
  const rgba = new Uint8Array(384 * 572 * 4);
  for (let y = 0; y < 572; y++) {
    for (let x = 0; x < 384; x++) {
      rgba[(y * 384 + x) * 4 + 3] = opaque(Math.floor(y / 52), Math.floor(x / 48)) ? 255 : 0;
    }
  }
  const pet = { rows: 11, columns: 8, cellW: 192, cellH: 208, hasLookFrames: true, spriteUrl: 'test.png' };
  window.QP = QP;
  window.QPPhysics = QPPhysics;
  window.matchMedia = () => ({ matches: false });
  window.quotaPet = {
    getState: async () => ({ pet, metrics: { spriteW: 120, spriteH: 125 }, config: {}, quota: {} }),
    // 页面不再直接改原生穿透，只上报判断；这里用“是否要接住鼠标”记录，语义和原来一致。
    setHit: (over) => { ignoring = !over; calls.ignores.push(!over); },
    setHitMap: (map) => calls.hitMaps.push(map),
    setHitBubble: (rect) => calls.bubbles.push(rect),
    cursorAck: () => calls.acks++,
    probeAck: () => calls.probeAcks++,
    setPetIcon() {},
    interactionHeartbeat: () => calls.heartbeats++,
    dragStart: () => calls.starts++, dragEnd: (fling) => { calls.ends++; calls.flings.push(fling); },
    dragMove: (dx, dy) => calls.moves.push([dx, dy]), petClick: () => calls.clicks++, petMenu() {},
    wander: () => calls.wanders++, motionStop: () => calls.motionStops++,
    ...Object.fromEntries(['Quota', 'Config', 'Pet', 'Cursor', 'InteractionReset', 'PanelVisible', 'Debug', 'Probe',
      'Motion', 'Away', 'Edge'].map((name) => [`on${name}`, (cb) => { subscriptions[name] = cb; }])),
  };
  const context = vm.createContext({
    window, console, Uint8Array,
    document: {
      getElementById: (id) => elements[id],
      documentElement: { style: { setProperty() {} } },
      createElement: (tag) => tag === 'canvas' ? {
        getContext: () => ({ drawImage() {}, getImageData: () => ({ data: rgba }) }),
        toDataURL: () => 'data:image/png;base64,',
      } : element({}),
    },
    Image: class { naturalWidth = 1536; naturalHeight = 2288; async decode() {} },
    setTimeout: (cb, delay) => { timers.set(++timerId, { cb, delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id), setInterval: (cb, delay) => intervals.set(delay, cb),
    requestAnimationFrame: (cb) => { cb(); },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/pet.js'), 'utf8'), context);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  return {
    sprite, bubble, badge, fx, window, calls, subscriptions,
    get ignoring() { return ignoring; },
    loseNativeHitState(value) { ignoring = value; },
    runInterval(delay) { intervals.get(delay)(); },
    runTimer(delay) {
      const entry = [...timers].find(([, t]) => t.delay === delay);
      assert.ok(entry, `Expected an active ${delay}ms timer`);
      timers.delete(entry[0]);
      entry[1].cb();
    },
  };
}

const pointer = (extra = {}) => ({
  pointerId: 7, button: 0, buttons: 1, screenX: 500, screenY: 400, clientX: 130, clientY: 146, ...extra,
});

test('stationary cursor: newly opaque animation pixels receive clicks', async () => {
  const pet = await createPet({ opaque: (row, col) => row === 0 && col === 1 });
  pet.subscriptions.Cursor({ x: 130, y: 146 });
  assert.equal(pet.ignoring, true);
  pet.runTimer(1680); // Idle frame 0 -> 1, with no mouse movement.
  assert.equal(pet.ignoring, false);
});

test('native passthrough lost after a desktop switch is repaired at an unchanged cursor', async () => {
  const pet = await createPet();
  pet.subscriptions.Cursor({ x: 130, y: 146 });
  pet.loseNativeHitState(true);
  pet.subscriptions.Cursor({ x: 130, y: 146, forceHitTest: true });
  assert.equal(pet.ignoring, false);
  pet.subscriptions.Cursor({ x: 3, y: 3 });
  pet.loseNativeHitState(false);
  pet.subscriptions.Cursor({ x: 3, y: 3, forceHitTest: true });
  assert.equal(pet.ignoring, true);
});

test('native passthrough calibration preserves an active captured drag', async () => {
  const pet = await createPet();
  pet.subscriptions.Cursor({ x: 130, y: 146 });
  pet.sprite.dispatch('pointerdown', pointer());
  pet.loseNativeHitState(true);
  pet.subscriptions.Cursor({ x: 3, y: 3, forceHitTest: true });
  assert.equal(pet.ignoring, false);
  assert.equal(pet.calls.ends, 0);
  pet.sprite.dispatch('pointermove', pointer({ screenX: 520 }));
  assert.equal(pet.calls.moves.length, 1);
});

test('renderer reports liveness even when the mouse is stationary', async () => {
  const pet = await createPet();
  pet.runInterval(1000);
  pet.runInterval(1000);
  assert.equal(pet.calls.heartbeats, 2);
});

test('stationary cursor: transparent animation pixels become click-through', async () => {
  const pet = await createPet({ opaque: (row) => row !== 7 });
  pet.subscriptions.Cursor({ x: 130, y: 146 });
  assert.equal(pet.ignoring, false);
  pet.subscriptions.Quota({ refreshing: true });
  assert.equal(pet.ignoring, true);
});

test('stationary cursor: showing and hiding a bubble updates mouse passthrough', async () => {
  const pet = await createPet();
  pet.subscriptions.Cursor({ x: 130, y: 20 });
  pet.subscriptions.Debug({ summary: true });
  assert.equal(pet.ignoring, false);
  pet.subscriptions.PanelVisible(true);
  assert.equal(pet.ignoring, true);
});

test('missing mouse-up: moving with no button cancels drag and allows the next click', async () => {
  const pet = await createPet();
  pet.sprite.dispatch('pointerdown', pointer());
  pet.sprite.dispatch('pointermove', pointer({ screenX: 520 }));
  assert.equal(pet.calls.moves.length, 1);
  pet.sprite.dispatch('pointermove', pointer({ screenX: 525, buttons: 0 }));
  assert.equal(pet.calls.ends, 1);
  assert.equal(pet.calls.moves.length, 1);
  assert.equal(pet.calls.clicks, 0);
  assert.equal(pet.sprite.classList.contains('dragging'), false);
  pet.sprite.dispatch('pointerdown', pointer());
  pet.sprite.dispatch('pointerup', pointer({ buttons: 0 }));
  assert.equal(pet.calls.clicks, 1);
});

test('capture failure still lets the press complete without leaving drag state behind', async () => {
  const pet = await createPet({ captureThrows: true });
  assert.doesNotThrow(() => pet.sprite.dispatch('pointerdown', pointer()));
  pet.sprite.dispatch('pointerup', pointer({ buttons: 0 }));
  assert.equal(pet.calls.starts, 1);
  assert.equal(pet.calls.ends, 1);
  assert.equal(pet.calls.clicks, 1);
});

test('forwarded mouse movement outside the sprite also clears a missed release', async () => {
  const pet = await createPet();
  pet.sprite.dispatch('pointerdown', pointer());
  pet.window.dispatch('mousemove', { clientX: 3, clientY: 3, buttons: 0 });
  assert.equal(pet.calls.ends, 1);
  assert.equal(pet.calls.clicks, 0);
  assert.equal(pet.ignoring, true);
});

test('animation changes cannot enable passthrough while the pointer is held', async () => {
  const pet = await createPet({ opaque: (row) => row !== 7 });
  pet.subscriptions.Cursor({ x: 130, y: 146 });
  pet.sprite.dispatch('pointerdown', pointer());
  pet.subscriptions.Quota({ refreshing: true });
  assert.equal(pet.ignoring, false);
  pet.sprite.dispatch('pointerup', pointer({ buttons: 0 }));
  assert.equal(pet.ignoring, true);
});

test('blur releases the captured pointer ID and does not generate a click', async () => {
  const pet = await createPet();
  pet.sprite.dispatch('pointerdown', pointer());
  pet.window.dispatch('blur');
  assert.deepEqual(pet.calls.released, [7]);
  assert.equal(pet.calls.ends, 1);
  assert.equal(pet.calls.clicks, 0);
});

test('zoomed page: polled window pixels are scaled into CSS pixels before hit testing', async () => {
  // A 260x208 window showing the page at 1.3x: the viewport is 200x160 CSS px, sprite at its bottom center.
  const pet = await createPet({
    viewport: { innerWidth: 200, innerHeight: 160 },
    spriteRect: { left: 40, top: 35, right: 160, bottom: 160, width: 120, height: 125 },
  });
  pet.subscriptions.Cursor({ x: 130, y: 190, w: 260, h: 208 }); // On the sprite as drawn on screen.
  assert.equal(pet.ignoring, false);
  pet.subscriptions.Cursor({ x: 150, y: 40, w: 260, h: 208 }); // Above the drawn sprite.
  assert.equal(pet.ignoring, true);
});

test('unlock reset cancels a captured drag without blur or mouse-up and allows the next click', async () => {
  const pet = await createPet();
  pet.subscriptions.Cursor({ x: 130, y: 146 });
  pet.sprite.dispatch('pointerdown', pointer());
  pet.sprite.dispatch('pointermove', pointer({ screenX: 520 }));
  pet.subscriptions.InteractionReset();
  assert.deepEqual(pet.calls.released, [7]);
  assert.equal(pet.calls.ends, 1);
  assert.equal(pet.calls.clicks, 0);
  assert.equal(pet.sprite.classList.contains('dragging'), false);
  assert.equal(pet.ignoring, true);
  // Polling must work again without any native mousemove event after unlock.
  pet.subscriptions.Cursor({ x: 130, y: 146 });
  assert.equal(pet.ignoring, false);
  pet.sprite.dispatch('pointerdown', pointer());
  pet.sprite.dispatch('pointerup', pointer({ buttons: 0 }));
  assert.equal(pet.calls.clicks, 1);
});

test('repeated session resets force native passthrough sync at an unchanged cursor position', async () => {
  const pet = await createPet();
  for (let i = 0; i < 20; i++) {
    pet.subscriptions.Cursor({ x: 130, y: 146 });
    assert.equal(pet.ignoring, false);
    pet.subscriptions.InteractionReset();
    const count = pet.calls.ignores.length;
    pet.subscriptions.InteractionReset();
    assert.equal(pet.calls.ignores.length, count + 1);
    assert.equal(pet.ignoring, true);
    pet.subscriptions.Cursor({ x: 130, y: 146 });
    assert.equal(pet.ignoring, false);
    pet.subscriptions.Cursor({ x: 3, y: 3 });
    assert.equal(pet.ignoring, true);
  }
  assert.equal(pet.calls.clicks, 0);
});

test('session reset removes a stale hover bubble and makes its old area click-through', async () => {
  const pet = await createPet();
  pet.subscriptions.Debug({ summary: true });
  pet.subscriptions.Cursor({ x: 130, y: 20 });
  assert.equal(pet.ignoring, false);
  pet.subscriptions.InteractionReset();
  assert.equal(pet.bubble.classList.contains('show'), false);
  pet.subscriptions.Cursor({ x: 130, y: 20 });
  assert.equal(pet.ignoring, true);
});

test('repeated refreshes and interrupted drags keep subsequent clicks working', async () => {
  const pet = await createPet({ opaque: (row) => row !== 7 });
  for (let i = 0; i < 200; i++) {
    pet.subscriptions.Cursor({ x: 130, y: 146 });
    pet.subscriptions.Quota({ refreshing: true });
    assert.equal(pet.ignoring, true);
    pet.subscriptions.Quota({ refreshing: false });
    assert.equal(pet.ignoring, false);
    pet.sprite.dispatch('pointerdown', pointer());
    pet.sprite.dispatch('pointermove', pointer({ screenX: 520 }));
    pet.window.dispatch('mousemove', { clientX: 3, clientY: 3, buttons: 0 });
    assert.equal(pet.ignoring, true);
    pet.sprite.dispatch('pointerdown', pointer());
    pet.sprite.dispatch('pointerup', pointer({ buttons: 0 }));
  }
  assert.equal(pet.calls.starts, 400);
  assert.equal(pet.calls.ends, 400);
  assert.equal(pet.calls.clicks, 200);
});

test('page uploads the opaque pixels of its current frame so the main process can hit test', async () => {
  const pet = await createPet({
    opaque: (row, col) => row === 0 && col === 0,
    viewport: { innerWidth: 260, innerHeight: 208 },
  });
  assert.ok(pet.calls.hitMaps.length > 0, 'a hit map must be published on load');
  const map = pet.calls.hitMaps.at(-1);
  assert.equal(map.cellW, 192);
  assert.equal(map.cellH, 208);
  assert.equal(map.cols, Math.ceil(192 / 4));
  assert.equal(map.rows, Math.ceil(208 / 4));
  assert.equal(map.viewport.w, 260);
  assert.equal(map.sprite.width, 120);
  assert.ok(map.alpha, 'the alpha mask must be uploaded for sprite pets');
  assert.ok(map.alpha.some((v) => v > 40));
  assert.equal(map.alpha.reduce((a, b) => a + (b > 40 ? 1 : 0), 0), 48 * 52);
});

test('page acknowledges cursor updates and answers the recovery probe', async () => {
  const pet = await createPet({ viewport: { innerWidth: 260, innerHeight: 208 } });
  pet.subscriptions.Cursor({ x: 130, y: 146, seq: 7 });
  assert.equal(pet.calls.acks, 1);
  pet.subscriptions.Probe('token-1');
  assert.equal(pet.calls.probeAcks, 1);
  assert.ok(pet.calls.hitMaps.length > 0, 'the probe response must carry a fresh hit map');
});

test('page reports bubble geometry so hovering the bubble still catches the mouse', async () => {
  const pet = await createPet({ viewport: { innerWidth: 260, innerHeight: 208 } });
  pet.calls.bubbles.length = 0;
  pet.subscriptions.Debug({ summary: true });
  const shown = pet.calls.bubbles.at(-1);
  assert.ok(shown && shown.width > 0 && shown.height > 0, 'a visible bubble must publish its rect');
  pet.bubble.classList.remove('show');
  pet.subscriptions.InteractionReset();
  assert.equal(pet.calls.bubbles.at(-1), null, 'hiding the bubble must clear the rect');
});

// ---------- 撸猫、甩出去、睡觉、回满庆祝 ----------

const stroke = (pet, xs, y = 146) => {
  for (const x of xs) pet.window.dispatch('mousemove', { clientX: x, clientY: y, buttons: 0 });
};

test('stroking back and forth over the pet pets it: hearts and a purr bubble, no click', async () => {
  const pet = await createPet();
  pet.subscriptions.Cursor({ x: 130, y: 146 });
  stroke(pet, [130, 145, 130, 145, 130]);
  assert.equal(pet.fx.children.length, 3);
  assert.equal(pet.bubble.classList.contains('show'), true);
  assert.equal(pet.calls.clicks, 0);
  stroke(pet, [145, 130, 145, 130]); // 两秒内再蹭不重复触发
  assert.equal(pet.fx.children.length, 3);
});

test('mouse jitter on the pet does not count as petting', async () => {
  const pet = await createPet();
  pet.subscriptions.Cursor({ x: 130, y: 146 });
  stroke(pet, [130, 131, 130, 131, 130, 131, 130, 131]);
  assert.equal(pet.fx.children.length, 0);
});

test('a fast release reports a fling velocity; a release after a pause just sets the pet down', async () => {
  const pet = await createPet();
  pet.sprite.dispatch('pointerdown', pointer({ timeStamp: 1000 }));
  for (let i = 1; i <= 5; i++) {
    pet.sprite.dispatch('pointermove', pointer({ screenX: 500 + i * 30, screenY: 400 - i * 8, timeStamp: 1000 + i * 10 }));
  }
  pet.sprite.dispatch('pointerup', pointer({ screenX: 650, buttons: 0, timeStamp: 1055 }));
  const fling = pet.calls.flings.at(-1);
  assert.ok(fling && fling.vx > 2000 && fling.vy < 0, JSON.stringify(fling));
  assert.equal(pet.calls.clicks, 0);
  pet.subscriptions.Motion({ kind: 'end', reason: 'land', was: 'fly', impact: 400 });

  pet.sprite.dispatch('pointerdown', pointer({ timeStamp: 2000 }));
  for (let i = 1; i <= 5; i++) pet.sprite.dispatch('pointermove', pointer({ screenX: 500 + i * 30, timeStamp: 2000 + i * 10 }));
  pet.sprite.dispatch('pointerup', pointer({ screenX: 650, buttons: 0, timeStamp: 2300 }));
  assert.equal(pet.calls.flings.at(-1), null);
});

test('pressing the pet while it flies catches it instead of opening the panel', async () => {
  const pet = await createPet();
  pet.subscriptions.Motion({ kind: 'fly' });
  pet.sprite.dispatch('pointerdown', pointer());
  pet.subscriptions.Motion({ kind: 'end', reason: 'catch', was: 'fly' });
  pet.sprite.dispatch('pointerup', pointer({ buttons: 0 }));
  assert.equal(pet.calls.starts, 1);
  assert.equal(pet.calls.clicks, 0);
  pet.sprite.dispatch('pointerdown', pointer());
  pet.sprite.dispatch('pointerup', pointer({ buttons: 0 }));
  assert.equal(pet.calls.clicks, 1, 'the next plain click opens the panel again');
});

test('hovering a walking pet asks it to stop so it can be clicked', async () => {
  const pet = await createPet();
  pet.subscriptions.Motion({ kind: 'walk', dir: 'left' });
  pet.subscriptions.Cursor({ x: 130, y: 146 });
  assert.equal(pet.calls.motionStops, 1);
});

test('away: the pet sleeps with a 💤 badge and reports the time away when the user is back', async () => {
  const pet = await createPet();
  pet.subscriptions.Away({ away: true });
  assert.equal(pet.badge.textContent, '💤');
  assert.equal(pet.badge.hidden, false);
  assert.equal(pet.sprite.classList.contains('sleeping'), true);
  pet.subscriptions.Away({ away: false, awayMs: 80 * 60e3 });
  assert.equal(pet.sprite.classList.contains('sleeping'), false);
  assert.equal(pet.badge.hidden, true);
  pet.runTimer(2500);
  assert.equal(pet.bubble.classList.contains('show'), true);
  assert.match(pet.bubble.innerHTML, /你离开了 1 小时 20 分/);
});

test('a short absence with nothing changed wakes the pet quietly', async () => {
  const pet = await createPet();
  pet.subscriptions.Away({ away: true });
  pet.subscriptions.Away({ away: false, awayMs: 6 * 60e3 });
  pet.runTimer(2500);
  assert.equal(pet.bubble.classList.contains('show'), false);
});

const quotaSnap = (used) => ({
  refreshing: false,
  codex: { status: 'ok', data: { windows: [{ key: 'primary', usedPercent: used, windowMins: 300 }] } },
});

test('a quota reset between refreshes celebrates with a bubble and confetti', async () => {
  const pet = await createPet();
  pet.subscriptions.Quota(quotaSnap(93));
  pet.subscriptions.Quota(quotaSnap(1));
  assert.match(pet.bubble.innerHTML, /Codex 5 小时额度回满啦/);
  assert.match(pet.bubble.innerHTML, /可以继续干活啦/);
  assert.equal(pet.fx.children.length, 4);
});

test('the head badge shows 💦 when quota is tight and ❗ when every source fails', async () => {
  const pet = await createPet();
  pet.subscriptions.Quota(quotaSnap(75));
  assert.equal(pet.badge.textContent, '💦');
  assert.equal(pet.badge.dataset.kind, 'warn');
  pet.subscriptions.Quota({ refreshing: false, codex: { status: 'error', data: null } });
  assert.equal(pet.badge.textContent, '❗');
  pet.subscriptions.Quota(quotaSnap(40));
  assert.equal(pet.badge.hidden, true);
});

test('quota alerts wait until a flying pet has landed', async () => {
  const pet = await createPet();
  pet.subscriptions.Motion({ kind: 'fly' });
  pet.subscriptions.Quota(quotaSnap(95));
  assert.equal(pet.bubble.classList.contains('show'), false);
  pet.subscriptions.Motion({ kind: 'end', reason: 'land', was: 'fly', impact: 500 });
  assert.match(pet.bubble.innerHTML, /只剩 5%/);
});

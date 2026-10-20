'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const QP = require('../renderer/shared');

// Run the actual renderer with controlled animation timers and sprite alpha pixels.
async function createPet({ opaque = () => true, captureThrows = false } = {}) {
  const timers = new Map();
  const subscriptions = {};
  const calls = { starts: 0, ends: 0, clicks: 0, moves: [], released: [] };
  let timerId = 0;
  let ignoring = true; // Initial native BrowserWindow state.
  function element(rect) {
    const events = new Map();
    const classes = new Set();
    return {
      style: {}, dataset: {}, hidden: false,
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
  const sprite = element({ left: 70, top: 84, right: 190, bottom: 209, width: 120, height: 125 });
  const bubble = element({ left: 0, top: 0, right: 260, bottom: 60, width: 260, height: 60 });
  bubble.hidden = true;
  const window = element({});
  const rgba = new Uint8Array(384 * 572 * 4);
  for (let y = 0; y < 572; y++) {
    for (let x = 0; x < 384; x++) {
      rgba[(y * 384 + x) * 4 + 3] = opaque(Math.floor(y / 52), Math.floor(x / 48)) ? 255 : 0;
    }
  }
  const pet = { rows: 11, columns: 8, cellW: 192, cellH: 208, hasLookFrames: true, spriteUrl: 'test.png' };
  window.QP = QP;
  window.matchMedia = () => ({ matches: false });
  window.quotaPet = {
    getState: async () => ({ pet, metrics: { spriteW: 120, spriteH: 125 }, config: {}, quota: {} }),
    setIgnoreMouse: (ignore) => { ignoring = ignore; },
    setPetIcon() {},
    dragStart: () => calls.starts++, dragEnd: () => calls.ends++,
    dragMove: (dx, dy) => calls.moves.push([dx, dy]), petClick: () => calls.clicks++, petMenu() {},
    ...Object.fromEntries(['Quota', 'Config', 'Pet', 'Cursor', 'PanelVisible', 'Debug']
      .map((name) => [`on${name}`, (cb) => { subscriptions[name] = cb; }])),
  };
  const context = vm.createContext({
    window, console, Uint8Array,
    document: {
      getElementById: (id) => id === 'sprite' ? sprite : bubble,
      documentElement: { style: { setProperty() {} } },
      createElement: () => ({
        getContext: () => ({ drawImage() {}, getImageData: () => ({ data: rgba }) }),
        toDataURL: () => 'data:image/png;base64,',
      }),
    },
    Image: class { naturalWidth = 1536; naturalHeight = 2288; async decode() {} },
    setTimeout: (cb, delay) => { timers.set(++timerId, { cb, delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id), setInterval() {},
    requestAnimationFrame: (cb) => { cb(); },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/pet.js'), 'utf8'), context);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  return {
    sprite, bubble, window, calls, subscriptions,
    get ignoring() { return ignoring; },
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

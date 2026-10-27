'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { LinuxSurface, desktopBounds } = require('../src/linux-surface');

function surface() {
  const sent = [], commands = [], cursor = [], errors = [];
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { writable: true, write: (s) => commands.push(JSON.parse(s)) }),
    kill() { this.killed = true; },
  });
  const win = {
    getNativeWindowHandle: () => Buffer.from([1, 0, 0, 0]), isDestroyed: () => false,
    setBounds() { assert.fail('pet animation must never move or resize the native overlay'); },
    setPosition() { assert.fail('pet animation must never move the native overlay'); },
    webContents: { isDestroyed: () => false, isCrashed: () => false, send: (channel, payload) => sent.push({ channel, payload }) },
  };
  const instance = new LinuxSurface(win, { screenToDipPoint: (p) => ({ x: p.x / 2, y: p.y / 2 }) },
    { x: 500, y: 300, width: 260, height: 209 }, { x: 80, y: 32, width: 2480, height: 1408 },
    (p) => cursor.push(p), (e) => errors.push(e), () => child);
  return { instance, child, sent, commands, cursor, errors };
}

test('Linux drag and flight update only the iframe; native overlay stays still', () => {
  const s = surface();
  for (let i = 0; i < 120; i++) s.instance.setBounds({ x: 500 + i * 2, y: 300 - i });
  assert.equal(s.sent.length, 120);
  assert.deepEqual(s.sent.at(-1).payload, { x: 658, y: 149, width: 260, height: 209 });
  assert.equal(s.instance.bounds.x, 738);
  s.instance.close();
  assert.equal(s.child.killed, true);
});

test('Linux input regions are independent of drawing and identical updates are skipped', () => {
  const s = surface();
  const rects = [{ x: 200, y: 100, width: 115, height: 125 }];
  s.instance.setInputRects(rects);
  s.instance.setInputRects(rects);
  assert.deepEqual(s.commands, [{ rects, width: 2480, height: 1408 }]);
});

test('Linux pointer input keeps the newest complete sample without replaying stale moves', () => {
  const s = surface();
  s.child.stdout.emit('data', Buffer.from('{"x":20,"y":40,"buttons":256}\n{"x":60'));
  s.child.stdout.emit('data', Buffer.from(',"y":80,"buttons":256}\n{"x":100,"y":120,"buttons":0}\n'));
  assert.deepEqual(s.cursor, [{ x: 10, y: 20, buttons: 256 }, { x: 50, y: 60, buttons: 0 }]);
  s.instance.close();
  s.child.emit('exit', null, 'SIGTERM');
  assert.deepEqual(s.errors, []);
});

test('Linux desktop surface includes negative monitor coordinates and respects desktop panels', () => {
  assert.deepEqual(desktopBounds([
    { workArea: { x: -1920, y: 32, width: 1920, height: 1048 } },
    { workArea: { x: 80, y: 32, width: 2480, height: 1408 } },
  ]), { x: -1920, y: 32, width: 4480, height: 1408 });
});

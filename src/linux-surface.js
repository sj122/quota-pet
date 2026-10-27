'use strict';

const path = require('path');
const { spawn } = require('child_process');

// The native X11 window stays still. Only the iframe containing the pet moves.
class LinuxSurface {
  constructor(win, screen, bounds, overlay, onCursor, onError, spawnHelper = spawn) {
    this.win = win;
    this.screen = screen;
    this.bounds = { ...bounds };
    this.overlay = { ...overlay };
    this.cursor = null;
    this.closed = false;
    this.inputKey = '';
    this.buffer = '';
    const xid = win.getNativeWindowHandle().readUInt32LE(0);
    this.child = spawnHelper('python3', ['-u', path.join(__dirname, 'linux-x11.py'), String(xid)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdin.on('error', () => {}); // A stopped helper may have a pending write.
    this.child.on('error', (err) => { if (!this.closed) onError(err.message); });
    this.child.on('exit', (code, signal) => {
      if (!this.closed) onError(`X11 helper exited (${code ?? signal})`);
    });
    this.child.stderr.on('data', (data) => { if (!this.closed) onError(data.toString().trim()); });
    this.child.stdout.on('data', (data) => {
      this.buffer += data.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop();
      // Use the newest pointer sample if the main process was busy; never replay a queue of moves.
      const line = lines.at(-1);
      if (!line || this.closed) return;
      let sample;
      try { sample = JSON.parse(line); } catch { return; }
      if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y)) return;
      this.cursor = { ...screen.screenToDipPoint({ x: sample.x, y: sample.y }), buttons: sample.buttons };
      onCursor(this.cursor);
    });
  }

  frame() {
    return { x: this.bounds.x - this.overlay.x, y: this.bounds.y - this.overlay.y,
      width: this.bounds.width, height: this.bounds.height };
  }

  publish() {
    const wc = this.win.webContents;
    if (!this.win.isDestroyed() && !wc.isDestroyed() && !wc.isCrashed()) wc.send('pet:surface', this.frame());
  }

  setBounds(bounds) {
    this.bounds = { ...this.bounds, ...bounds };
    this.publish();
  }

  setInputRects(rects) {
    if (this.closed || !this.child.stdin.writable) return;
    const key = JSON.stringify({ rects, width: this.overlay.width, height: this.overlay.height });
    if (key === this.inputKey) return;
    this.inputKey = key;
    this.child.stdin.write(key + '\n');
  }

  close() {
    this.closed = true;
    this.child.kill();
  }
}

function desktopBounds(displays) {
  const areas = displays.map((d) => d.workArea || d.bounds);
  const x = Math.min(...areas.map((b) => b.x));
  const y = Math.min(...areas.map((b) => b.y));
  return { x, y,
    width: Math.max(...areas.map((b) => b.x + b.width)) - x,
    height: Math.max(...areas.map((b) => b.y + b.height)) - y };
}

module.exports = { LinuxSurface, desktopBounds };

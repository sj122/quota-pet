(() => {
  'use strict';

  const api = window.quotaPet;
  const QP = window.QP;
  const spriteEl = document.getElementById('sprite');
  const bubbleEl = document.getElementById('bubble');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ALPHA_SCALE = 4; // 命中测试用的透明度图按 1/4 分辨率采样
  const IDLE_ACTIONS = ['waving', 'jumping', 'review'];

  let pet = null;
  let cfg = {};
  let snapshot = null;
  let alphaMap = null;
  let frame = { row: 0, col: 0 };
  let anim = { timer: 0, frames: [], idx: 0, loopStart: 0, state: 'idle', loop: false };
  let interactive = false;
  let pressed = null;
  let dragging = false;
  let hovering = false;
  let hoverTimer = 0;
  let looking = false;
  let lookTimer = 0;
  let lastActivity = Date.now();
  let refreshing = false;
  let panelVisible = false;
  let bubbleKind = null;
  let bubbleTimer = 0;
  let hideTimer = 0;
  let lastPointer = null;
  let shownAlerts = new Set();

  // ---------- 动画 ----------

  function setFrame(f) {
    frame = f;
    if (!pet) return;
    const x = pet.columns > 1 ? (f.col / (pet.columns - 1)) * 100 : 0;
    const y = pet.rows > 1 ? (f.row / (pet.rows - 1)) * 100 : 0;
    spriteEl.style.backgroundPosition = `${x}% ${y}%`;
    // 动画也会改变鼠标下的透明像素，不能只等鼠标移动再更新穿透。
    syncHitTest();
  }

  function play(state, opts = {}) {
    clearTimeout(anim.timer);
    clearTimeout(lookTimer);
    looking = false;
    const tl = QP.timeline(state, { ...opts, reduced });
    anim = { timer: 0, frames: tl.frames, idx: 0, loopStart: tl.loopStart, state, loop: Boolean(opts.loop) };
    if (pet) tick();
  }

  function tick() {
    const f = anim.frames[anim.idx];
    setFrame(f);
    if (anim.frames.length <= 1 || anim.loopStart == null) return;
    anim.timer = setTimeout(() => {
      anim.idx += 1;
      if (anim.idx >= anim.frames.length) anim.idx = anim.loopStart;
      // 一次性动作播完后，状态回到 idle（帧序列里已经接上了 idle 循环）
      if (!anim.loop && anim.state !== 'idle' && anim.idx >= anim.loopStart) anim.state = 'idle';
      tick();
    }, f.ms);
  }

  const isIdle = () => anim.state === 'idle' && !dragging;

  // ---------- 眼睛跟随鼠标（v2 精灵图才有看向帧） ----------

  function updateLook(x, y) {
    if (!cfg.eyeFollow || reduced || !pet || !pet.hasLookFrames || !isIdle() || hovering || refreshing) {
      stopLook();
      return;
    }
    const r = spriteEl.getBoundingClientRect();
    const dx = x - (r.left + r.width / 2);
    const dy = y - (r.top + r.height * 0.45);
    const dist = Math.hypot(dx, dy);
    const f = dist >= r.height * 0.5 && dist <= 900 ? QP.lookFrame(dx, dy) : null;
    if (!f) {
      stopLook();
      return;
    }
    if (!looking) {
      clearTimeout(anim.timer);
      looking = true;
    }
    setFrame(f);
    clearTimeout(lookTimer);
    lookTimer = setTimeout(stopLook, 2200);
  }

  function stopLook() {
    if (!looking) return;
    looking = false;
    clearTimeout(lookTimer);
    play('idle');
  }

  // ---------- 命中测试：只有落在不透明像素上才接住鼠标，其余区域穿透到桌面 ----------

  const inRect = (x, y, r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  const bubbleVisible = () => !bubbleEl.hidden && bubbleEl.classList.contains('show');

  function hitPet(x, y) {
    const r = spriteEl.getBoundingClientRect();
    if (!inRect(x, y, r)) return false;
    if (!pet || !alphaMap) return true;
    const fx = ((x - r.left) / r.width) * pet.cellW;
    const fy = ((y - r.top) / r.height) * pet.cellH;
    const sx = Math.floor((frame.col * pet.cellW + fx) / ALPHA_SCALE);
    const sy = Math.floor((frame.row * pet.cellH + fy) / ALPHA_SCALE);
    const { data, w, h } = alphaMap;
    for (let oy = -2; oy <= 2; oy++) {
      for (let ox = -2; ox <= 2; ox++) {
        const ax = sx + ox;
        const ay = sy + oy;
        if (ax >= 0 && ay >= 0 && ax < w && ay < h && data[ay * w + ax] > 40) return true;
      }
    }
    return false;
  }

  function setInteractive(over) {
    if (over === interactive) return;
    interactive = over;
    api.setIgnoreMouse(!over);
  }

  // 这里只同步原生命中状态，不触发悬停/看向动画，避免换帧递归。
  function syncHitTest() {
    if (!lastPointer) return;
    const { x, y } = lastPointer;
    const onBubble = bubbleVisible() && inRect(x, y, bubbleEl.getBoundingClientRect());
    const onPet = !onBubble && hitPet(x, y);
    const over = Boolean(pressed) || onBubble || onPet;
    setInteractive(over);
    return { onBubble, onPet, over };
  }

  function onPointer(x, y) {
    lastPointer = { x, y };
    const { onBubble, onPet, over } = syncHitTest();
    if (onPet && !hovering) startHover();
    else if (!onPet && hovering && !pressed) endHover();
    if (bubbleKind === 'summary') {
      if (onPet || onBubble) cancelHide();
      else scheduleHide(300);
    }
    if (!over) updateLook(x, y);
  }

  function startHover() {
    hovering = true;
    lastActivity = Date.now();
    stopLook();
    if (isIdle() && !refreshing) play('jumping', { repeat: 1 });
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      if (hovering && !panelVisible && !pressed) showSummary();
    }, 650);
  }

  function endHover() {
    hovering = false;
    clearTimeout(hoverTimer);
  }

  // ---------- 气泡 ----------

  function showBubble(lines, { kind = 'info', tone = 'info', ttl = 0 } = {}) {
    clearTimeout(bubbleTimer);
    cancelHide();
    bubbleEl.innerHTML = lines.map((l) => `<div class="line">${QP.escapeHtml(l)}</div>`).join('');
    bubbleEl.dataset.tone = tone;
    bubbleEl.hidden = false;
    bubbleKind = kind;
    requestAnimationFrame(() => {
      bubbleEl.classList.add('show');
      syncHitTest();
    });
    if (ttl) bubbleTimer = setTimeout(hideBubble, ttl);
  }

  function hideBubble() {
    clearTimeout(bubbleTimer);
    cancelHide();
    bubbleEl.classList.remove('show');
    bubbleKind = null;
    syncHitTest();
    setTimeout(() => {
      if (!bubbleEl.classList.contains('show')) bubbleEl.hidden = true;
    }, 220);
  }

  function scheduleHide(delay) {
    if (hideTimer) return;
    hideTimer = setTimeout(() => {
      hideTimer = 0;
      hideBubble();
    }, delay);
  }

  function cancelHide() {
    clearTimeout(hideTimer);
    hideTimer = 0;
  }

  function showSummary() {
    const lines = snapshot ? QP.summaryLines(snapshot) : [];
    showBubble(lines.length ? lines : ['还在读取额度…'], { kind: 'summary' });
  }

  bubbleEl.addEventListener('click', () => {
    hideBubble();
    api.petClick();
  });

  // ---------- 拖动与点击（移动超过 4px 算拖动，和 Codex 一致） ----------

  spriteEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // 上一次若漏收松手事件，新的一次按下也必须能恢复正常。
    release(null, true);
    pressed = { pointerId: e.pointerId, x: e.screenX, y: e.screenY, lastX: e.screenX, moved: false };
    setInteractive(true);
    api.dragStart();
    try {
      spriteEl.setPointerCapture(e.pointerId);
    } catch {} // 捕获失效时仍由 window 的松手/移动事件结束本次操作。
  });

  spriteEl.addEventListener('pointermove', (e) => {
    if (!pressed || e.pointerId !== pressed.pointerId) return;
    if ((e.buttons & 1) === 0) {
      release(e, true);
      return;
    }
    const dx = e.screenX - pressed.x;
    const dy = e.screenY - pressed.y;
    if (!pressed.moved && Math.hypot(dx, dy) >= 4) {
      pressed.moved = true;
      dragging = true;
      spriteEl.classList.add('dragging');
      hideBubble();
    }
    if (!pressed.moved) return;
    api.dragMove(dx, dy);
    const vx = e.screenX - pressed.lastX;
    if (Math.abs(vx) >= 3) {
      const state = vx > 0 ? 'running-right' : 'running-left';
      if (anim.state !== state) play(state, { loop: true });
      pressed.lastX = e.screenX;
    }
  });

  function release(e, cancelled) {
    if (!pressed || (e && e.pointerId !== pressed.pointerId)) return;
    const { moved, pointerId } = pressed;
    pressed = null;
    dragging = false;
    spriteEl.classList.remove('dragging');
    try {
      spriteEl.releasePointerCapture(pointerId);
    } catch {}
    api.dragEnd();
    lastActivity = Date.now();
    if (e && Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
      lastPointer = { x: e.clientX, y: e.clientY };
    }
    if (moved) play('idle');
    else if (!cancelled) api.petClick();
    syncHitTest();
  }

  spriteEl.addEventListener('pointerup', (e) => release(e, false));
  spriteEl.addEventListener('pointercancel', (e) => release(e, true));
  // 兜底：指针捕获意外丢失、或松手时落在宠物外面，也要结束拖动
  spriteEl.addEventListener('lostpointercapture', (e) => release(e, true));
  window.addEventListener('pointerup', (e) => release(e, !pressed || !pressed.moved));
  window.addEventListener('blur', () => release(null, true));
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.petMenu();
  });
  window.addEventListener('mousemove', (e) => {
    // 非聚焦的透明窗口可能漏收 pointerup；下次移动时用真实按钮状态纠正。
    // 保留 mousemove：Windows 的穿透转发路径只保证转发鼠标移动消息。
    if (pressed && (e.buttons & 1) === 0) release(null, true);
    onPointer(e.clientX, e.clientY);
  });
  api.onCursor(({ x, y }) => {
    if (!pressed) onPointer(x, y);
  });

  // ---------- 额度变化 → 宠物反应 ----------

  function onQuota(snap) {
    const was = refreshing;
    snapshot = snap;
    refreshing = Boolean(snap && snap.refreshing);
    if (refreshing && !was && !dragging && !looking) play('running', { loop: true });
    if (!refreshing && was) afterRefresh();
    // 静默更新（比如 Claude 桌面端刚写了新记录）也要马上检查告急
    else if (!refreshing) showNewAlerts();
    if (bubbleKind === 'summary') showSummary();
  }

  // 只提醒新出现的告急项；返回是否弹了提醒
  function showNewAlerts() {
    const active = QP.alerts(snapshot, cfg);
    const fresh = active.filter((a) => !shownAlerts.has(a.key));
    shownAlerts = new Set(active.map((a) => a.key));
    if (dragging || !fresh.length) return false;
    play('failed');
    showBubble(
      fresh.slice(0, 3).map((a) => a.text),
      { kind: 'alert', tone: 'warn', ttl: 10000 }
    );
    return true;
  }

  function afterRefresh() {
    if (showNewAlerts() || dragging) return;
    const slots = ['codex', 'claude', 'deepseek'].map((n) => snapshot[n]).filter((s) => s && s.status !== 'off');
    if (slots.length && slots.every((s) => s.status === 'error')) play('waiting');
    else if (panelVisible) play('review', { repeat: 1 });
    else play('idle');
  }

  // ---------- 加载宠物 ----------

  function setVar(name, value) {
    document.documentElement.style.setProperty(name, value);
  }

  function buildAlpha(img) {
    const w = Math.ceil(img.naturalWidth / ALPHA_SCALE);
    const h = Math.ceil(img.naturalHeight / ALPHA_SCALE);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const data = new Uint8Array(w * h);
    for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4 + 3];
    alphaMap = { data, w, h };
    syncHitTest();
  }

  // 某一格里不透明像素的包围盒（原图像素，相对这一格的左上角）
  function contentBounds(row, col) {
    const { data, w } = alphaMap;
    const x0 = Math.floor((col * pet.cellW) / ALPHA_SCALE);
    const y0 = Math.floor((row * pet.cellH) / ALPHA_SCALE);
    const x1 = Math.floor(((col + 1) * pet.cellW) / ALPHA_SCALE);
    const y1 = Math.floor(((row + 1) * pet.cellH) / ALPHA_SCALE);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -1;
    let maxY = -1;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (data[y * w + x] <= 40) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return null;
    return {
      left: minX * ALPHA_SCALE - col * pet.cellW,
      top: minY * ALPHA_SCALE - row * pet.cellH,
      right: (maxX + 1) * ALPHA_SCALE - col * pet.cellW,
      bottom: (maxY + 1) * ALPHA_SCALE - row * pet.cellH,
    };
  }

  // 用 idle 第一帧裁出头像，给托盘图标和面板用
  function sendIcon(img, b) {
    const size = Math.max(b.right - b.left, b.bottom - b.top);
    const cx = (b.left + b.right) / 2;
    const cy = (b.top + b.bottom) / 2;
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size, 0, 0, 64, 64);
    api.setPetIcon(c.toDataURL('image/png'));
  }

  function sendOrbIcon() {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(24, 20, 4, 32, 32, 30);
    g.addColorStop(0, '#c9d3ff');
    g.addColorStop(0.45, '#6f86ff');
    g.addColorStop(1, '#3346c8');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(32, 32, 29, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1b1b1f';
    for (const x of [24, 40]) {
      ctx.beginPath();
      ctx.arc(x, 34, 3.6, 0, Math.PI * 2);
      ctx.fill();
    }
    api.setPetIcon(c.toDataURL('image/png'));
  }

  async function loadPet(info, metrics) {
    pet = info;
    alphaMap = null;
    setVar('--sprite-w', `${metrics.spriteW}px`);
    setVar('--sprite-h', `${metrics.spriteH}px`);
    setVar('--bubble-bottom', `${Math.round(metrics.spriteH * 0.92)}px`);
    syncHitTest();
    if (!pet) {
      spriteEl.className = 'sprite orb';
      spriteEl.style.backgroundImage = 'none';
      sendOrbIcon();
      return;
    }
    spriteEl.className = 'sprite';
    spriteEl.style.backgroundImage = `url("${pet.spriteUrl}")`;
    spriteEl.style.backgroundSize = `${pet.columns * 100}% ${pet.rows * 100}%`;
    play('idle');
    try {
      const img = new Image();
      img.src = pet.spriteUrl;
      await img.decode();
      if (pet !== info) return;
      buildAlpha(img);
      const b = contentBounds(0, 0);
      if (b) {
        const headTop = metrics.spriteH - (b.top / pet.cellH) * metrics.spriteH;
        setVar('--bubble-bottom', `${Math.round(headTop + 6)}px`);
        sendIcon(img, b);
      }
    } catch (err) {
      console.warn('加载精灵图失败', err);
    }
  }

  // 闲着太久就随机做个小动作
  setInterval(() => {
    if (!cfg.idleSelfPlay || reduced || !pet) return;
    if (!isIdle() || looking || hovering || pressed || refreshing || panelVisible) return;
    if (Date.now() - lastActivity < 45000 || Math.random() < 0.5) return;
    lastActivity = Date.now();
    play(IDLE_ACTIONS[Math.floor(Math.random() * IDLE_ACTIONS.length)], { repeat: 1 });
  }, 20000);

  api.onQuota(onQuota);
  api.onConfig((c) => {
    cfg = c || cfg;
    if (!cfg.eyeFollow) stopLook();
  });
  api.onPet(({ pet: p, metrics, config: c }) => {
    cfg = c || cfg;
    hideBubble();
    loadPet(p, metrics);
  });
  api.onPanelVisible((visible) => {
    panelVisible = visible;
    if (!visible) return;
    if (bubbleKind === 'summary' || bubbleKind === 'greet') hideBubble();
    if (isIdle() && !refreshing && !looking) play('waving', { repeat: 1 });
  });
  api.onDebug((d) => {
    if (d && d.summary) showSummary();
  });

  (async () => {
    const st = await api.getState();
    cfg = st.config || {};
    snapshot = st.quota;
    refreshing = Boolean(snapshot && snapshot.refreshing);
    await loadPet(st.pet, st.metrics);
    setTimeout(() => {
      if (hovering || panelVisible || bubbleKind) return;
      play('waving', { repeat: 2 });
      showBubble(['我来帮你盯着额度啦～', '点我看看详情'], { kind: 'greet', ttl: 4500 });
    }, 700);
  })();
})();

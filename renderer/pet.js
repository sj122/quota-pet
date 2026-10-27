(() => {
  'use strict';

  const api = window.petApi || window.quotaPet;
  const QP = window.QP;
  const PHYS = window.QPPhysics;
  const spriteEl = document.getElementById('sprite');
  const bubbleEl = document.getElementById('bubble');
  const badgeEl = document.getElementById('badge');
  const fxEl = document.getElementById('fx');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ALPHA_SCALE = 4; // 命中测试用的透明度图按 1/4 分辨率采样
  const IDLE_ACTIONS = ['waving', 'jumping', 'review'];
  const PET_LINES = ['呼噜呼噜～', '好舒服喵～', '再摸摸～', '嘿嘿，好痒', '最喜欢你啦'];
  const LAND_LINES = ['晕乎乎的…', '哎哟，摔疼了', '好玩！再来一次'];
  const BADGES = { sleep: '💤', error: '❗', danger: '💦', warn: '💦' };
  const CHAT_GAP = 20 * 60e3; // 两次闲聊至少隔 20 分钟
  const REPORT_AFTER = 15 * 60e3; // 离开超过 15 分钟，或者期间额度有变化，回来才汇报
  const KEEP_ON_HOVER = ['alert', 'report', 'celebrate']; // 悬停时不会被额度摘要顶掉的气泡

  let pet = null;
  let cfg = {};
  let snapshot = null;
  let lastSeen = null; // 上一次处理过的额度快照，用来发现“回满”
  let alphaMap = null;
  let frame = { row: 0, col: 0 };
  let anim = { timer: 0, frames: [], idx: 0, loopStart: 0, state: 'idle', loop: false };
  let interactive = false;
  let pressed = null;
  let dragging = false;
  let linuxNativeDrag = false;
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
  let motion = null; // 主进程正在移动窗口：'fly' 被扔出去，'walk' 在散步
  let throws = [];
  let sleeping = false;
  let awayBase = null; // 睡着那一刻的额度快照，回来时拿来对比
  let report = null;
  let reportTimer = 0;
  let headTop = 0; // 头顶离精灵图底边的距离，放气泡和特效用
  let edge = { left: 0, right: 0 }; // 窗口露在屏幕外的宽度
  let stroke = null; // 撸猫手势：鼠标来回蹭的方向变化
  let lastPetAt = 0;
  let petted = { day: '', count: 0 };
  let lastChatAt = Date.now() - CHAT_GAP + 10 * 60e3; // 启动 10 分钟后才开始闲聊
  let lastChat = '';

  // ---------- 动画 ----------

  function setFrame(f) {
    frame = f;
    if (!pet) return;
    const x = pet.columns > 1 ? (f.col / (pet.columns - 1)) * 100 : 0;
    const y = pet.rows > 1 ? (f.row / (pet.rows - 1)) * 100 : 0;
    spriteEl.style.backgroundPosition = `${x}% ${y}%`;
    // 动画也会改变鼠标下的透明像素，不能只等鼠标移动再更新穿透。
    syncHitTest();
    publishHitMap();
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

  // 精灵图里没有睡觉的动作：停在待机第一帧，配合呼吸起伏和头顶的 💤
  function freezeAsleep() {
    clearTimeout(anim.timer);
    clearTimeout(lookTimer);
    looking = false;
    anim = { timer: 0, frames: [QP.ANIMS.idle[0]], idx: 0, loopStart: null, state: 'sleep', loop: true };
    if (pet) setFrame(QP.ANIMS.idle[0]);
  }

  const isIdle = () => anim.state === 'idle' && !dragging && !motion && !sleeping;

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

  // 原生穿透由主进程按透明度图决定；这里只把页面自己的判断报上去，用于诊断和兜底。
  function setInteractive(over) {
    if (over === interactive) return;
    interactive = over;
    api.setHit(over);
  }

  // 当前帧哪一块像素不透明，交给主进程去算命中。窗口被缩放、换了显示器时，
  // 靠这里的 sprite 矩形 + viewport 换算，主进程不用猜页面的布局。
  let hitMapKey = '';
  function publishHitMap() {
    if (!pet) {
      api.setHitMap(null);
      return;
    }
    const s = spriteEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (!pet.cellW || !pet.cellH || !(s.width > 0) || !(s.height > 0) || !(vw > 0) || !(vh > 0)) return;
    const q = ALPHA_SCALE;
    const cols = Math.ceil(pet.cellW / q);
    const rows = Math.ceil(pet.cellH / q);
    const key = `${frame.row},${frame.col},${Math.round(s.left)},${Math.round(s.top)},${Math.round(s.width)},${Math.round(s.height)},${Math.round(vw)},${Math.round(vh)},${alphaMap ? 1 : 0}`;
    if (key === hitMapKey) return;
    hitMapKey = key;
    let alpha = null;
    if (alphaMap) {
      alpha = new Uint8Array(cols * rows);
      const { data, w, h } = alphaMap;
      const ox = Math.floor((frame.col * pet.cellW) / q);
      const oy = Math.floor((frame.row * pet.cellH) / q);
      for (let y = 0; y < rows; y++) {
        const sy = oy + y;
        if (sy < 0 || sy >= h) continue;
        for (let x = 0; x < cols; x++) {
          const sx = ox + x;
          if (sx >= 0 && sx < w) alpha[y * cols + x] = data[sy * w + sx];
        }
      }
    }
    api.setHitMap({
      cell: { row: frame.row, col: frame.col },
      cellW: pet.cellW,
      cellH: pet.cellH,
      q,
      cols,
      rows,
      alpha,
      sprite: { left: s.left, top: s.top, width: s.width, height: s.height },
      viewport: { w: vw, h: vh },
    });
  }

  // 气泡也在窗口里，鼠标移上去同样得接住。
  function publishBubble() {
    if (!bubbleEl || !bubbleVisible()) {
      api.setHitBubble(null);
      return;
    }
    const r = bubbleEl.getBoundingClientRect();
    api.setHitBubble({ left: r.left, top: r.top, width: r.width, height: r.height });
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
    // 鼠标碰到正在散步的宠物就停下来，方便点它
    if (motion === 'walk') api.motionStop();
    stopLook();
    if (isIdle() && !refreshing) play('jumping', { repeat: 1 });
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      if (hovering && !panelVisible && !pressed && !motion && !KEEP_ON_HOVER.includes(bubbleKind)) showSummary();
    }, 650);
  }

  function endHover() {
    hovering = false;
    stroke = null;
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
    placeBubble();
    requestAnimationFrame(() => {
      bubbleEl.classList.add('show');
      syncHitTest();
      publishBubble();
    });
    if (ttl) bubbleTimer = setTimeout(hideBubble, ttl);
  }

  function hideBubble() {
    clearTimeout(bubbleTimer);
    cancelHide();
    bubbleEl.classList.remove('show');
    bubbleKind = null;
    syncHitTest();
    publishBubble();
    setTimeout(() => {
      if (!bubbleEl.classList.contains('show')) bubbleEl.hidden = true;
    }, 220);
  }

  // 宠物贴着屏幕边时窗口有一截在屏幕外：把气泡挪回看得见的地方，小尖角仍然指着宠物
  function placeBubble() {
    const W = window.innerWidth;
    const w = bubbleEl.offsetWidth;
    let dx = 0;
    if (Number.isFinite(W) && w > 0) {
      const lo = edge.left + 4;
      const hi = W - edge.right - 4;
      const left = (W - w) / 2;
      if (left < lo) dx = lo - left;
      else if (left + w > hi) dx = hi - left - w;
      dx = Math.max(14 - w / 2, Math.min(w / 2 - 14, dx));
    }
    bubbleEl.style.setProperty('--bubble-dx', `${Math.round(dx)}px`);
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

  // ---------- 头顶小图标与飘出来的小表情 ----------

  // 💤 睡着、❗ 全部读取失败、💦 额度紧张；用来表达精灵图里没有的状态
  function updateBadge() {
    if (!badgeEl) return;
    const kind = sleeping ? 'sleep' : snapshot ? QP.mood(snapshot, cfg) : 'ok';
    if (badgeEl.dataset.kind === kind) return;
    badgeEl.dataset.kind = kind;
    badgeEl.textContent = BADGES[kind] || '';
    badgeEl.hidden = !BADGES[kind];
  }

  // 一串往上飘的小表情（爱心、彩带），纯装饰，不参与命中测试
  function burst(chars, x, y) {
    if (reduced || !fxEl || !Number.isFinite(x) || !Number.isFinite(y)) return;
    chars.forEach((ch, i) => {
      const el = document.createElement('span');
      el.className = 'particle';
      el.textContent = ch;
      el.style.left = `${Math.round(x + (i - (chars.length - 1) / 2) * 16)}px`;
      el.style.top = `${Math.round(y)}px`;
      el.style.animationDelay = `${i * 80}ms`;
      fxEl.appendChild(el);
      setTimeout(() => el.remove(), 1300 + i * 80);
    });
  }

  function headPoint() {
    const r = spriteEl.getBoundingClientRect();
    return { x: (r.left + r.right) / 2, y: r.bottom - (headTop || r.height * 0.9) };
  }

  // ---------- 撸猫：鼠标在宠物身上来回蹭 ----------

  // 1.2 秒内换向 3 次（每段至少 8px）算撸了一下。只看原生鼠标移动：主进程轮询的坐标稍有延迟，混在一起会来回抖。
  function trackStroke(x, y) {
    const now = Date.now();
    if (!stroke) {
      stroke = { x, dir: 0, run: 0, flips: [] };
      return;
    }
    const dx = x - stroke.x;
    if (Math.abs(dx) < 2) return;
    stroke.x = x;
    const dir = dx > 0 ? 1 : -1;
    if (dir === stroke.dir) stroke.run += Math.abs(dx);
    else {
      if (stroke.dir && stroke.run >= 8) stroke.flips.push(now);
      stroke.dir = dir;
      stroke.run = Math.abs(dx);
    }
    stroke.flips = stroke.flips.filter((t) => now - t <= 1200);
    if (stroke.flips.length >= 3 && now - lastPetAt >= 2000) {
      stroke.flips = [];
      onPetted(x, y);
    }
  }

  function onPetted(x, y) {
    const now = Date.now();
    const day = new Date(now).toDateString();
    petted = { day, count: petted.day === day ? petted.count + 1 : 1 };
    lastPetAt = now;
    lastActivity = now;
    clearTimeout(hoverTimer);
    burst(['❤️', '💕', '❤️'], x, y - 12);
    if (!motion && !sleeping && !refreshing && !dragging) play('jumping', { repeat: 1 });
    if (bubbleKind === 'alert' || bubbleKind === 'report') return;
    const line = petted.count % 10 === 0
      ? `今天已经摸了我 ${petted.count} 下啦`
      : PET_LINES[Math.floor(Math.random() * PET_LINES.length)];
    showBubble([line], { kind: 'pet', ttl: 2600 });
  }

  // ---------- 拖动与点击（移动超过 4px 算拖动，和 Codex 一致） ----------

  const canThrow = () => cfg.throwable !== false && !reduced && Boolean(PHYS);

  spriteEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // 上一次若漏收松手事件，新的一次按下也必须能恢复正常。
    release(null, true);
    // 飞在半空时按住就是接住它：松手不开面板，原地放下
    const caught = motion === 'fly';
    motion = null;
    if (sleeping) wake();
    pressed = { pointerId: e.pointerId, x: e.screenX, y: e.screenY, lastX: e.screenX, moved: false, caught, samples: [] };
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
      // 被拎起来先在半空扑腾，横着拖再换成跑步
      play('jumping', { loop: true });
    }
    if (!pressed.moved) return;
    api.dragMove(dx, dy);
    // 浏览器会把一帧内的多次移动合并成一个事件；按合并前的每一次记录轨迹，甩出的速度才准
    const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const ev of coalesced.length ? coalesced : [e]) {
      if (Number.isFinite(ev.timeStamp)) pressed.samples.push({ t: ev.timeStamp, x: ev.screenX, y: ev.screenY });
    }
    if (pressed.samples.length > 32) pressed.samples.splice(0, pressed.samples.length - 32);
    const vx = e.screenX - pressed.lastX;
    if (Math.abs(vx) >= 3) {
      const state = vx > 0 ? 'running-right' : 'running-left';
      if (anim.state !== state) play(state, { loop: true });
      pressed.lastX = e.screenX;
    }
  });

  function release(e, cancelled) {
    if (!pressed || (e && e.pointerId !== pressed.pointerId)) return;
    const { moved, pointerId, samples, caught } = pressed;
    pressed = null;
    dragging = false;
    spriteEl.classList.remove('dragging');
    try {
      spriteEl.releasePointerCapture(pointerId);
    } catch {}
    // 松手前一小段拖得够快就是“甩出去”，交给主进程按物理飞；慢慢放下就停在原地
    const allowFling = Boolean(moved && !cancelled && e && canThrow());
    const fling = allowFling && !linuxNativeDrag ? PHYS.releaseVelocity(samples, e.timeStamp) : null;
    api.dragEnd(fling, allowFling);
    lastActivity = Date.now();
    if (e && Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
      lastPointer = { x: e.clientX, y: e.clientY };
    }
    if (fling) {
      throws = [...throws.filter((t) => lastActivity - t < 30e3), lastActivity];
      startFlying();
    } else if (moved || caught) play('idle');
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
    if (hovering && !pressed && !motion) trackStroke(e.clientX, e.clientY);
  });
  window.addEventListener('mouseleave', () => {
    if (!pressed) onPointer(-1, -1);
  });
  // 主进程给的是窗口像素坐标和窗口尺寸，按视口比例换成 CSS 像素，页面缩放后也能对准宠物。
  api.onCursor(({ x, y, w, h, forceHitTest, seq }) => {
    // 告诉主进程“我还在处理鼠标消息”。通道长时间没有应答，主进程会自己重载/重建窗口。
    if (seq) api.cursorAck(seq);
    if (forceHitTest) interactive = null;
    if (pressed) {
      setInteractive(true);
      return;
    }
    onPointer(w ? (x * window.innerWidth) / w : x, h ? (y * window.innerHeight) / h : y);
  });
  api.onInteractionReset(() => {
    // 锁屏不保证触发 blur，必须显式释放捕获并丢掉旧坐标，避免卡在按住/悬停状态。
    lastPointer = null;
    release(null, true);
    endHover();
    stopLook();
    hideBubble();
    if (motion) {
      motion = null;
      play('idle');
    }
    interactive = null; // 强制重新上报页面判断，即使鼠标仍停在锁屏前同一个位置。
    setInteractive(false);
    lastActivity = Date.now();
  });
  // 主进程的恢复流程用它确认页面还活着；重新报一次命中信息，布局变了也能立刻纠正。
  api.onProbe((token) => {
    publishHitMap();
    publishBubble();
    api.probeAck(token);
  });
  window.addEventListener('resize', () => {
    publishHitMap();
    publishBubble();
  });

  // ---------- 被扔出去、散步：窗口由主进程移动，这里只管动作 ----------

  function startFlying() {
    motion = 'fly';
    hideBubble();
    stopLook();
    if (anim.state !== 'jumping' || !anim.loop) play('jumping', { loop: true });
  }

  // 落地、撞墙时压扁再弹回来；transform 要带上居中用的 translateX(-50%)
  function squash(side, speed) {
    const d = PHYS ? PHYS.squashDepth(speed) : 0;
    if (!d || reduced || typeof spriteEl.animate !== 'function') return;
    const flat = side === 'floor' || side === 'top';
    const sx = flat ? 1 + d * 0.6 : 1 - d * 0.6;
    const sy = flat ? 1 - d : 1 + d * 0.3;
    const back = (s) => 1 - (s - 1) * 0.3;
    const at = (a, b) => ({ transform: `translateX(-50%) scale(${a.toFixed(3)}, ${b.toFixed(3)})` });
    spriteEl.animate(
      [at(1, 1), { ...at(sx, sy), offset: 0.3 }, { ...at(back(sx), back(sy)), offset: 0.65 }, at(1, 1)],
      { duration: 300, easing: 'ease-out' }
    );
  }

  function landed(impact) {
    const now = Date.now();
    throws = throws.filter((t) => now - t < 30e3);
    if (throws.length >= 3) {
      throws = [];
      play('failed', { repeat: 1 });
      showBubble(['别扔我啦～头好晕'], { kind: 'land', ttl: 3200 });
    } else if (impact >= 1300) {
      play('failed', { repeat: 1 });
      if (Math.random() < 0.5) showBubble([LAND_LINES[Math.floor(Math.random() * LAND_LINES.length)]], { kind: 'land', ttl: 2600 });
    } else {
      play('idle');
    }
  }

  function onMotion(m) {
    if (!m || pressed) return; // 按住时由拖动接管动作
    if (m.kind === 'fly') startFlying();
    else if (m.kind === 'walk') {
      motion = 'walk';
      stopLook();
      play(m.dir === 'left' ? 'running-left' : 'running-right', { loop: true });
    } else if (m.kind === 'slide') {
      if (motion === 'fly') play(m.dir === 'left' ? 'running-left' : 'running-right', { loop: true });
    } else if (m.kind === 'impact') {
      squash(m.side, m.speed);
    } else if (m.kind === 'refused') {
      // 被放在半空、不在任务栏上就不散步，换个原地小动作
      if (isIdle() && cfg.idleSelfPlay) play(IDLE_ACTIONS[Math.floor(Math.random() * IDLE_ACTIONS.length)], { repeat: 1 });
    } else if (m.kind === 'end') {
      const was = motion;
      motion = null;
      lastActivity = Date.now();
      if (was === 'fly' && m.reason === 'land') landed(m.impact);
      else if (was) play('idle');
      showNewAlerts(); // 飞着、走着时攒下的告急这时再提醒
    }
  }

  // ---------- 额度变化 → 宠物反应 ----------

  function onQuota(snap) {
    const was = refreshing;
    const prev = lastSeen;
    snapshot = snap;
    refreshing = Boolean(snap && snap.refreshing);
    if (refreshing && !was && !dragging && !looking && !motion && !sleeping) play('running', { loop: true });
    if (!refreshing) {
      lastSeen = snap;
      if (sleeping) {
        // 睡着时不出声，回来汇报时一起对比
      } else if (report) {
        if (was && anim.state === 'running') play('idle');
        if (Date.now() >= report.at) tryReport();
      } else if (was) afterRefresh(prev);
      // 静默更新（比如 Claude 桌面端刚写了新记录）也要马上检查告急和回满
      else if (!showNewAlerts()) celebrate(prev);
    }
    if (bubbleKind === 'summary') showSummary();
    updateBadge();
  }

  // 新出现的告急项；记下来，同一项不重复提醒
  function takeFreshAlerts() {
    const active = QP.alerts(snapshot, cfg);
    const fresh = active.filter((a) => !shownAlerts.has(a.key));
    shownAlerts = new Set(active.map((a) => a.key));
    return fresh;
  }

  // 只提醒新出现的告急项；返回是否弹了提醒。睡着、飞着、走着时先攒着，回来或落地后再说。
  function showNewAlerts() {
    if (sleeping || motion) return false;
    const fresh = takeFreshAlerts();
    if (dragging || !fresh.length) return false;
    play('failed');
    showBubble(
      fresh.slice(0, 3).map((a) => a.text),
      { kind: 'alert', tone: 'warn', ttl: 10000 }
    );
    return true;
  }

  // 额度回满：蹦两下、撒彩带
  function celebrate(prev) {
    const events = QP.resetEvents(prev, snapshot, cfg);
    if (!events.length || dragging || motion || sleeping) return false;
    const lines = events.slice(0, 2).map((ev) => ev.text);
    if (events.some((ev) => ev.wasLow)) lines.push('可以继续干活啦～');
    play('jumping', { repeat: 2 });
    const h = headPoint();
    burst(['🎉', '✨', '🎊', '✨'], h.x, h.y);
    showBubble(lines, { kind: 'celebrate', ttl: 7000 });
    return true;
  }

  function afterRefresh(prev) {
    if (showNewAlerts() || dragging || motion) return;
    if (celebrate(prev)) return;
    const slots = ['codex', 'claude', 'deepseek'].map((n) => snapshot[n]).filter((s) => s && s.status !== 'off');
    if (slots.length && slots.every((s) => s.status === 'error')) play('waiting');
    else if (panelVisible) play('review', { repeat: 1 });
    else play('idle');
  }

  // ---------- 离开就睡，回来汇报 ----------

  function onAway(a) {
    if (!a) return;
    if (a.away) {
      if (sleeping) return;
      sleeping = true;
      awayBase = snapshot;
      endHover();
      if (bubbleKind !== 'alert') hideBubble();
      if (!reduced) spriteEl.classList.add('sleeping');
      freezeAsleep();
      updateBadge();
      return;
    }
    // 按住宠物时可能已经先醒了；汇报仍以主进程算的离开时长为准
    const base = awayBase;
    awayBase = null;
    if (sleeping) wake();
    if (a.silent || !base) return;
    // 等解锁后的窗口校准和补刷新做完再说，免得气泡刚出来就被收掉
    clearTimeout(reportTimer);
    report = { base, awayMs: Number(a.awayMs) || 0, at: Date.now() + 2500 };
    reportTimer = setTimeout(tryReport, 2500);
  }

  function wake() {
    sleeping = false;
    spriteEl.classList.remove('sleeping');
    lastActivity = Date.now();
    updateBadge();
    if (!pressed && !motion) play('waving', { repeat: 1 });
  }

  function tryReport() {
    if (!report) return;
    clearTimeout(reportTimer);
    // 补刷新还没回来就再等等，最多等 8 秒
    if (refreshing && Date.now() - report.at < 8000) {
      reportTimer = setTimeout(tryReport, 1000);
      return;
    }
    const r = report;
    report = null;
    const fresh = takeFreshAlerts();
    const lines = [...fresh.map((x) => x.text), ...QP.awayReport(r.base, snapshot)];
    if (!lines.length && r.awayMs < REPORT_AFTER) return;
    if (fresh.length) play('failed');
    showBubble([`欢迎回来～你离开了 ${QP.duration(r.awayMs)}`, ...lines.slice(0, 3)], {
      kind: fresh.length ? 'alert' : 'report',
      tone: fresh.length ? 'warn' : 'info',
      ttl: 10000,
    });
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
    motion = null;
    headTop = Math.round(metrics.spriteH * 0.92);
    setVar('--sprite-w', `${metrics.spriteW}px`);
    setVar('--sprite-h', `${metrics.spriteH}px`);
    setVar('--bubble-bottom', `${headTop}px`);
    setVar('--badge-x', `${Math.round(metrics.spriteW * 0.24)}px`);
    setVar('--badge-y', `${Math.round(metrics.spriteH * 0.7)}px`);
    syncHitTest();
    publishHitMap();
    if (!pet) {
      spriteEl.className = sleeping && !reduced ? 'sprite orb sleeping' : 'sprite orb';
      spriteEl.style.backgroundImage = 'none';
      sendOrbIcon();
      return;
    }
    spriteEl.className = sleeping && !reduced ? 'sprite sleeping' : 'sprite';
    spriteEl.style.backgroundImage = `url("${pet.spriteUrl}")`;
    spriteEl.style.backgroundSize = `${pet.columns * 100}% ${pet.rows * 100}%`;
    if (sleeping) freezeAsleep();
    else play('idle');
    try {
      const img = new Image();
      img.src = pet.spriteUrl;
      await img.decode();
      if (pet !== info) return;
      buildAlpha(img);
      publishHitMap();
      const b = contentBounds(0, 0);
      if (b) {
        headTop = metrics.spriteH - (b.top / pet.cellH) * metrics.spriteH;
        setVar('--bubble-bottom', `${Math.round(headTop + 6)}px`);
        // 小图标挂在身体轮廓的右上角
        setVar('--badge-x', `${Math.round((b.right / pet.cellW - 0.5) * metrics.spriteW - 6)}px`);
        setVar('--badge-y', `${Math.round(headTop - 18)}px`);
        sendIcon(img, b);
      }
    } catch (err) {
      console.warn('加载精灵图失败', err);
    }
  }

  // 独立于鼠标和动画报告页面是否仍能执行 JavaScript。
  setInterval(() => api.interactionHeartbeat(), 1000);
  // 闲着太久就随机做个小动作，或者沿着任务栏走几步
  setInterval(() => {
    if ((!cfg.idleSelfPlay && !cfg.wander) || reduced || !pet) return;
    if (!isIdle() || looking || hovering || pressed || refreshing || panelVisible) return;
    if (Date.now() - lastActivity < 45000 || Math.random() < 0.5) return;
    lastActivity = Date.now();
    if (cfg.wander && (!cfg.idleSelfPlay || Math.random() < 0.4)) api.wander();
    else play(IDLE_ACTIONS[Math.floor(Math.random() * IDLE_ACTIONS.length)], { repeat: 1 });
  }, 20000);
  // 看场合说句话：闲着、没人碰、离上次开口够久，才偶尔说一句
  setInterval(() => {
    if (cfg.chatter === false || !snapshot) return;
    if (!isIdle() || looking || hovering || pressed || refreshing || panelVisible || bubbleKind) return;
    const now = Date.now();
    if (now - lastChatAt < CHAT_GAP || now - lastActivity < 60e3 || Math.random() < 0.65) return;
    const pick = QP.pickLine(QP.chatterLines(snapshot, cfg, now), Math.random, lastChat);
    if (!pick) return;
    lastChatAt = now;
    lastChat = pick.lines.join('');
    play('waving', { repeat: 1 });
    showBubble(pick.lines, { kind: 'chat', ttl: 6000 });
  }, 60e3);

  api.onQuota(onQuota);
  api.onMotion(onMotion);
  api.onAway(onAway);
  api.onEdge((e) => {
    edge = { left: Math.max(0, Number(e && e.left) || 0), right: Math.max(0, Number(e && e.right) || 0) };
    if (bubbleEl.hidden) return;
    placeBubble();
    publishBubble(); // 气泡挪了位置，主进程按新矩形判断要不要接住鼠标
  });
  api.onConfig((c) => {
    cfg = c || cfg;
    if (!cfg.eyeFollow) stopLook();
    updateBadge();
  });
  api.onPet(({ pet: p, metrics, config: c }) => {
    cfg = c || cfg;
    hideBubble();
    loadPet(p, metrics);
  });
  api.onPanelVisible((visible) => {
    panelVisible = visible;
    if (!visible) return;
    if (bubbleKind && bubbleKind !== 'alert') hideBubble();
    if (isIdle() && !refreshing && !looking) play('waving', { repeat: 1 });
  });
  api.onDebug((d) => {
    if (d && d.summary) showSummary();
    if (d && d.pet) {
      const h = headPoint();
      onPetted(h.x, h.y + 24);
    }
  });

  (async () => {
    const st = await api.getState();
    linuxNativeDrag = Boolean(st.linuxNativeDrag);
    cfg = st.config || {};
    snapshot = st.quota;
    lastSeen = snapshot && !snapshot.refreshing ? snapshot : null;
    refreshing = Boolean(snapshot && snapshot.refreshing);
    await loadPet(st.pet, st.metrics);
    if (linuxNativeDrag) api.surfaceReady();
    updateBadge();
    setTimeout(() => {
      if (hovering || panelVisible || bubbleKind || sleeping || motion) return;
      play('waving', { repeat: 2 });
      showBubble(QP.greeting(), { kind: 'greet', ttl: 4500 });
    }, 700);
  })();
})();

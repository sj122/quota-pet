// 抛掷、弹跳和散步用的纯函数物理：主进程（require）按它推进窗口，宠物页面（<script>）用它估算松手速度、算落地挤压。
// 手感参考 dsh-pet（MIT）：重力 1400 px/s²、地面摩擦 2.5/s；弹性比它稍低，落地后弹几下就停。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QPPhysics = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PHYSICS = {
    gravity: 1400, // px/s²
    restitution: 0.62, // 撞墙、落地后保留的速度比例
    friction: 2.5, // 贴地滑行时每秒损失的速度比例
    maxDt: 0.05, // 定时器被耽搁时也只推进这么久，避免一步穿墙
    maxSubstep: 8, // 一个子步最多走 8px，高速时拆成多步检测碰撞
    settleVy: 40, // 落地时竖直速度低于它就不再弹起
    restVx: 15, // 贴地水平速度低于它就算停稳
  };

  const RELEASE = {
    window: 120, // 只看松手前 120ms 的轨迹
    stale: 90, // 松手前停顿超过 90ms 算“放下”，不算“甩出去”
    minSpan: 20,
    deadZone: 600, // 低于 600 px/s 算轻轻放下，原地不动
    knee: 2400, // 超过这个速度开始软压缩
    cap: 3600, // 甩得再猛也不超过它
  };

  // samples：拖动中记录的 [{ t, x, y }]（毫秒、屏幕坐标，按时间先后）；返回 { vx, vy }（px/s），不算甩出去时返回 null
  function releaseVelocity(samples, releaseAt, opts = RELEASE) {
    if (!Array.isArray(samples) || !samples.length || !Number.isFinite(releaseAt)) return null;
    const last = samples[samples.length - 1];
    if (!Number.isFinite(last.t) || releaseAt - last.t > opts.stale) return null;
    const recent = samples.filter((s) => Number.isFinite(s.t) && last.t - s.t <= opts.window);
    const first = recent[0];
    const span = last.t - first.t;
    if (recent.length < 2 || span < opts.minSpan) return null;
    const vx = ((last.x - first.x) / span) * 1000;
    const vy = ((last.y - first.y) / span) * 1000;
    const speed = Math.hypot(vx, vy);
    if (!(speed >= opts.deadZone)) return null;
    const soft = speed <= opts.knee ? speed : opts.knee + (opts.cap - opts.knee) * Math.tanh((speed - opts.knee) / (opts.cap - opts.knee));
    const k = soft / speed;
    return { vx: vx * k, vy: vy * k };
  }

  // 推进一帧。state 是宠物身体（精灵图那一块）左上角的位置和速度；box 是左上角允许的范围：
  // 左右是屏幕工作区两边，上沿是屏幕顶，下沿是任务栏（脚踩在 maxY 上）。返回新状态和这一帧撞到的边。
  function flightStep(state, dtSec, box, p = PHYSICS) {
    let { x, y, vx, vy } = state;
    const hits = [];
    const dt = Math.min(Math.max(Number(dtSec) || 0, 0), p.maxDt);
    const n = Math.min(64, Math.max(1, Math.ceil((Math.hypot(vx, vy) * dt) / p.maxSubstep)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      vy += p.gravity * h;
      x += vx * h;
      y += vy * h;
      if (x < box.minX || x > box.maxX) {
        const left = x < box.minX;
        x = left ? box.minX : box.maxX;
        if (left ? vx < 0 : vx > 0) {
          hits.push({ side: left ? 'left' : 'right', speed: Math.abs(vx) });
          vx = -vx * p.restitution;
        }
      }
      if (y < box.minY) {
        y = box.minY;
        if (vy < 0) {
          hits.push({ side: 'top', speed: -vy });
          vy = -vy * p.restitution;
        }
      }
      if (y >= box.maxY) {
        y = box.maxY;
        if (vy > p.settleVy) {
          hits.push({ side: 'floor', speed: vy });
          vy = -vy * p.restitution;
        } else if (vy > 0) {
          vy = 0;
        }
        vx *= Math.max(0, 1 - p.friction * h);
      }
    }
    return { state: { x, y, vx, vy }, hits };
  }

  const grounded = (s, box) => s.y >= box.maxY - 0.5;
  const atRest = (s, box, p = PHYSICS) => grounded(s, box) && Math.abs(s.vy) < 1 && Math.abs(s.vx) < p.restVx;

  // 落地挤压的深度（0～0.4）：撞得越重压得越扁，轻轻落地不压
  function squashDepth(speed) {
    if (!(speed > 300)) return 0;
    return Math.min(0.4, 0.12 + ((speed - 300) / 1200) * 0.28);
  }

  // 散步目标：在“家”左右 leash 范围内、屏幕工作区里挑一个点，至少走 minStep；
  // 走远了的时候只剩回家的方向有空间，自然就往回走。x、home 都是身体左边的横坐标。
  function walkTarget({ x, minX, maxX, home, leash, minStep, maxStep }, rand = Math.random) {
    const lo = Math.max(minX, home - leash);
    const hi = Math.min(maxX, home + leash);
    const dirs = [];
    if (x - lo >= minStep) dirs.push(-1);
    if (hi - x >= minStep) dirs.push(1);
    if (!dirs.length) return null;
    const dir = dirs[Math.min(dirs.length - 1, Math.floor(rand() * dirs.length))];
    const room = Math.min(maxStep, dir < 0 ? x - lo : hi - x);
    return x + dir * (minStep + rand() * (room - minStep));
  }

  return { PHYSICS, RELEASE, releaseVelocity, flightStep, grounded, atRest, squashDepth, walkTarget };
});

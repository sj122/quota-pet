'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('../renderer/physics');
const QP = require('../renderer/shared');

const H = 3600e3;
const D = 86400e3;
// 1920×1040 的工作区、115×125 的宠物身体：身体左上角能到的范围
const box = { minX: 0, maxX: 1805, minY: 0, maxY: 915 };

function fly(s, { dt = 0.016, steps = 3000 } = {}) {
  const hits = [];
  let n = 0;
  for (; n < steps && !P.atRest(s, box); n++) {
    const r = P.flightStep(s, dt, box);
    s = r.state;
    hits.push(...r.hits);
    assert.ok(s.x >= box.minX && s.x <= box.maxX && s.y >= box.minY && s.y <= box.maxY, `出界了：${JSON.stringify(s)}`);
  }
  return { s, hits, seconds: n * dt };
}

test('物理：甩向右边会撞墙反弹，最后落在任务栏上停稳', () => {
  const { s, hits, seconds } = fly({ x: 1500, y: 400, vx: 2400, vy: -900 });
  assert.ok(P.atRest(s, box));
  assert.equal(s.y, box.maxY);
  const wall = hits.find((h) => h.side === 'right');
  assert.ok(wall && wall.speed > 2000);
  assert.ok(hits.some((h) => h.side === 'floor'));
  assert.ok(seconds < 10, `${seconds}s 才停下`);
});

test('物理：往上甩会撞到屏幕顶弹回来', () => {
  const { hits } = fly({ x: 800, y: 500, vx: 0, vy: -3000 });
  assert.ok(hits.some((h) => h.side === 'top'));
});

test('物理：落地后一次比一次弹得低', () => {
  const { hits } = fly({ x: 800, y: 0, vx: 0, vy: 0 });
  const floor = hits.filter((h) => h.side === 'floor').map((h) => h.speed);
  assert.ok(floor.length >= 3);
  for (let i = 1; i < floor.length; i++) assert.ok(floor[i] < floor[i - 1]);
});

test('物理：定时器被耽搁很久，一步也不会穿墙', () => {
  const r = P.flightStep({ x: 1700, y: 900, vx: 3600, vy: -3600 }, 1, box);
  assert.ok(r.state.x <= box.maxX && r.state.y >= box.minY);
});

test('松手速度：快速甩出算抛出，方向和拖动方向一致', () => {
  const samples = [0, 10, 20, 30, 40].map((t, i) => ({ t: 1000 + t, x: 100 + i * 30, y: 500 - i * 10 }));
  const v = P.releaseVelocity(samples, 1045);
  assert.ok(v.vx > 2000 && v.vy < 0);
});

test('松手速度：慢慢拖、松手前停住、样本太少都算轻轻放下', () => {
  const slow = [0, 40, 80, 120].map((t, i) => ({ t, x: i * 8, y: 0 }));
  assert.equal(P.releaseVelocity(slow, 125), null);
  const fast = [0, 10, 20, 30].map((t, i) => ({ t, x: i * 40, y: 0 }));
  assert.equal(P.releaseVelocity(fast, 30 + 200), null, '停顿后才松手');
  assert.equal(P.releaseVelocity(fast.slice(0, 1), 31), null);
  assert.equal(P.releaseVelocity([{ t: 0, x: 0, y: 0 }, { t: 5, x: 60, y: 0 }], 6), null, '时间跨度太短不可信');
  assert.equal(P.releaseVelocity(fast, Number.NaN), null);
});

test('松手速度：甩得再猛也不超过上限', () => {
  const crazy = [0, 10, 20].map((t, i) => ({ t, x: i * 400, y: 0 }));
  const v = P.releaseVelocity(crazy, 21);
  assert.ok(v.vx <= P.RELEASE.cap && v.vx > P.RELEASE.knee);
});

test('落地挤压：轻轻落地不压，越重越扁，有上限', () => {
  assert.equal(P.squashDepth(200), 0);
  assert.ok(P.squashDepth(600) < P.squashDepth(1200));
  assert.equal(P.squashDepth(9000), 0.4);
});

test('散步：目标在家附近的工作区里，走远了只会往回走', () => {
  const opts = { x: 900, minX: 0, maxX: 1805, home: 900, leash: 290, minStep: 58, maxStep: 230 };
  for (let i = 0; i < 300; i++) {
    const t = P.walkTarget(opts);
    assert.ok(t >= 610 && t <= 1190);
    assert.ok(Math.abs(t - 900) >= 58 - 1e-9 && Math.abs(t - 900) <= 230 + 1e-9);
  }
  assert.ok(P.walkTarget({ ...opts, x: 615 }, () => 0.99) > 615, '已经在家左边尽头，只能往回走');
  assert.ok(P.walkTarget({ ...opts, x: 3, home: 0 }, () => 0) > 3, '贴着屏幕左边只能往右');
  assert.equal(P.walkTarget({ ...opts, minX: 880, maxX: 920 }), null, '没地方走就不走');
});

// ---------- 额度相关的反应 ----------

const NOW = new Date(2026, 9, 21, 1, 30).getTime(); // 周三凌晨 1:30

function snap(fiveHour, weekly = 40, extra = {}) {
  return {
    refreshing: false,
    codex: {
      status: 'ok',
      data: {
        source: 'http',
        windows: [
          { key: 'primary', usedPercent: fiveHour, windowMins: 300, resetsAt: NOW + H },
          { key: 'secondary', usedPercent: weekly, windowMins: 10080, resetsAt: NOW + 3 * D },
        ],
        ...extra,
      },
    },
    claude: { status: 'off' },
    deepseek: { status: 'off' },
  };
}

test('额度回满：5 小时额度从 93% 降到 2%，之前告急时补一句“可以继续干活”', () => {
  const ev = QP.resetEvents(snap(93), snap(2), { alertPercent: 10 });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].text, 'Codex 5 小时额度回满啦');
  assert.equal(ev[0].wasLow, true);
  const mid = QP.resetEvents(snap(60), snap(20), { alertPercent: 10 });
  assert.equal(mid[0].text, 'Codex 5 小时额度重置啦，剩 80%');
  assert.equal(mid[0].wasLow, false);
});

test('额度回满：小幅下降、原本就没怎么用、Claude 换了数据来源都不算', () => {
  assert.equal(QP.resetEvents(snap(50), snap(45)).length, 0);
  assert.equal(QP.resetEvents(snap(10), snap(0)).length, 0);
  assert.equal(QP.resetEvents(snap(80), snap(40)).length, 0, '降了但还用着四成，不像重置');
  assert.equal(QP.resetEvents(null, snap(0)).length, 0);
  const claude = (source, used) => ({
    claude: { status: 'ok', data: { source, windows: [{ key: 'five_hour', usedPercent: used, windowMins: 300 }] } },
  });
  assert.equal(QP.resetEvents(claude('desktop', 90), claude('oauth', 0)).length, 0);
  assert.equal(QP.resetEvents(claude('oauth', 90), claude('oauth', 0)).length, 1);
});

test('回来汇报：重置、离开期间又用掉的额度、DeepSeek 花费', () => {
  const before = snap(80, 40);
  const after = snap(3, 52);
  before.deepseek = { status: 'ok', data: { balances: [{ currency: 'CNY', total: 50 }] } };
  after.deepseek = { status: 'ok', data: { balances: [{ currency: 'CNY', total: 48.6 }] } };
  assert.deepEqual(QP.awayReport(before, after), [
    'Codex 5 小时额度已经重置',
    '期间 Codex 每周额度又用了 12%',
    '期间 DeepSeek 花了 ¥1.40',
  ]);
  assert.deepEqual(QP.awayReport(snap(40), snap(41)), []);
  assert.deepEqual(QP.awayReport(null, snap(41)), []);
});

test('头顶小图标：全部读取失败、告急、紧张、正常', () => {
  const failed = { codex: { status: 'error', data: null }, claude: { status: 'off' }, deepseek: { status: 'error', data: null } };
  assert.equal(QP.mood(failed, {}, NOW), 'error');
  assert.equal(QP.mood(snap(93), { alertPercent: 10 }, NOW), 'danger');
  assert.equal(QP.mood(snap(75), { alertPercent: 10 }, NOW), 'warn');
  assert.equal(QP.mood(snap(40), { alertPercent: 10 }, NOW), 'ok');
  assert.equal(QP.mood(null, {}, NOW), 'ok');
});

const texts = (list) => list.map((c) => c.lines.join(' '));

test('看场合说话：深夜、额度紧张、周额度快重置还剩很多', () => {
  const night = texts(QP.chatterLines(snap(40), {}, NOW));
  assert.ok(night.some((l) => l.startsWith('1 点了还不睡吗')));
  assert.ok(night.includes('我在帮你盯着额度哦'), '通用台词总有');

  const tight = texts(QP.chatterLines(snap(75), { alertPercent: 10 }, NOW));
  assert.ok(tight.includes('Codex 5 小时额度只剩 25% 省着点用～'));

  const s = snap(40, 40);
  s.codex.data.windows[1].resetsAt = NOW + 30 * H;
  const weekly = texts(QP.chatterLines(s, {}, NOW));
  assert.ok(weekly.includes('Codex 每周额度还剩 60% 1 天 6 小时后重置，别浪费～'));

  const soon = snap(70);
  soon.codex.data.windows[0].resetsAt = NOW + 20 * 60e3;
  assert.ok(texts(QP.chatterLines(soon, {}, NOW)).includes('Codex 5 小时额度只剩 30% 20 分钟后就重置啦'));

  const noon = texts(QP.chatterLines(snap(10, 10), {}, new Date(2026, 9, 21, 12, 0).getTime()));
  assert.ok(noon.includes('到饭点啦，先去吃饭吧'));
  assert.ok(noon.includes('额度很充足，放心用～'));
  assert.ok(!noon.some((l) => l.includes('不睡')));
});

test('看场合说话：按权重挑，不和上一条重复', () => {
  const c = [{ weight: 1, lines: ['a'] }, { weight: 3, lines: ['b'] }];
  assert.equal(QP.pickLine(c, () => 0, 'a').lines[0], 'b');
  assert.equal(QP.pickLine(c, () => 0.1).lines[0], 'a');
  assert.equal(QP.pickLine(c, () => 0.5).lines[0], 'b');
  assert.equal(QP.pickLine([], Math.random), null);
});

test('开场问候按时间段打招呼', () => {
  assert.match(QP.greeting(new Date(2026, 9, 21, 8).getTime())[0], /^早上好/);
  assert.match(QP.greeting(new Date(2026, 9, 21, 20).getTime())[0], /^晚上好/);
  assert.match(QP.greeting(NOW)[0], /^夜深了/);
});

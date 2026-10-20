'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeAppServer, normalizeWham } = require('../src/providers/codex');
const { estimateReset, mergeSamples, fromDesktop, normalizeOAuthUsage } = require('../src/providers/claude');
const { computeSpend, recordSnapshot, parseBalance } = require('../src/providers/deepseek');
const QP = require('../renderer/shared');

const H = 3600e3;
const MIN = 60e3;

test('codex: app-server 结果规整为 5 小时 + 每周两个窗口', () => {
  const r = normalizeAppServer({
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1792494712 },
      secondary: { usedPercent: 19, windowDurationMins: 10080, resetsAt: 1792955930 },
      planType: 'plus',
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: { codex: {} },
    rateLimitResetCredits: {
      availableCount: 2,
      credits: [
        { status: 'available', expiresAt: 1792699101 },
        { status: 'available', expiresAt: 1793298861 },
        { status: 'used', expiresAt: 1790000000 },
      ],
    },
  });
  assert.equal(r.plan, 'plus');
  assert.deepEqual(
    r.windows.map((w) => [w.key, w.usedPercent, w.windowMins, w.resetsAt]),
    [
      ['primary', 3, 300, 1792494712000],
      ['secondary', 19, 10080, 1792955930000],
    ]
  );
  assert.deepEqual(r.resetCredits, { count: 2, nextExpiresAt: 1792699101000 });
});

test('codex: API Key 登录没有额度时报错', () => {
  assert.throws(() => normalizeAppServer({ rateLimits: {} }), /没有订阅额度/);
});

test('codex: 直连 wham/usage 的结果也能规整', () => {
  const r = normalizeWham({
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 8, limit_window_seconds: 18000, reset_after_seconds: 17182, reset_at: 1792494712 },
      secondary_window: { used_percent: 20, limit_window_seconds: 604800, reset_after_seconds: 478401, reset_at: 1792955930 },
    },
    rate_limit_reset_credits: { available_count: 3 },
  });
  assert.equal(r.windows[0].windowMins, 300);
  assert.equal(r.windows[1].windowMins, 10080);
  assert.equal(r.windows[1].resetsAt, 1792955930000);
  assert.equal(r.resetCredits.count, 3);
});

test('claude: OAuth 用量接口', () => {
  const r = normalizeOAuthUsage({
    five_hour: { utilization: 23.5, resets_at: '2026-10-20T10:00:00Z' },
    seven_day: { utilization: 41, resets_at: '2026-10-24T03:00:00Z' },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 5, resets_at: null },
  });
  assert.deepEqual(
    r.windows.map((w) => [w.key, w.usedPercent, w.model]),
    [
      ['five_hour', 23.5, null],
      ['seven_day', 41, null],
      ['seven_day_sonnet', 5, 'Sonnet'],
    ]
  );
  assert.equal(r.windows[0].resetsAt, Date.parse('2026-10-20T10:00:00Z'));
});

test('claude: 从 0 变成有用量时，窗口起点落在两个采样点之间', () => {
  const t0 = Date.parse('2026-10-20T10:00:00Z');
  const s = [
    { t: t0, fh: 0 },
    { t: t0 + 10 * MIN, fh: 2 },
    { t: t0 + 20 * MIN, fh: 4 },
  ];
  const est = estimateReset(s, 'fh', 5 * H);
  assert.equal(est.kind, 'about');
  assert.equal(est.at, t0 + 5 * MIN + 5 * H);
});

test('claude: 用量下降说明中间重置过；间隔太大只给“最晚”', () => {
  const t0 = Date.parse('2026-10-20T00:00:00Z');
  const dropped = [
    { t: t0, fh: 60 },
    { t: t0 + 15 * MIN, fh: 3 },
  ];
  assert.equal(estimateReset(dropped, 'fh', 5 * H).kind, 'about');
  const gap = [
    { t: t0, fh: 0 },
    { t: t0 + 3 * H, fh: 12 },
  ];
  const est = estimateReset(gap, 'fh', 5 * H);
  assert.deepEqual(est, { at: t0 + 3 * H + 5 * H, kind: 'latest' });
  assert.equal(estimateReset([{ t: t0, fh: 0 }], 'fh', 5 * H), null);
});

test('claude: 合并桌面端采样并去重，周窗口只在看到起点时给估算', () => {
  const t0 = Date.parse('2026-10-20T00:00:00Z');
  const merged = mergeSamples(
    [{ t: t0, org: 'a', fh: 0, sd: 3 }],
    [
      { t: t0, org: 'a', fh: 0, sd: 3 },
      { t: t0 + 5 * MIN, org: 'a', fh: 2, sd: 4 },
    ]
  );
  assert.equal(merged.length, 2);
  const r = fromDesktop(merged);
  assert.equal(r.source, 'desktop');
  assert.equal(r.windows[0].estimate.kind, 'about');
  assert.equal(r.windows[1].estimate, null);
});

test('deepseek: 余额下降算消费，上升算充值', () => {
  const now = new Date(2026, 9, 20, 15, 0).getTime();
  const kid = 'k';
  const at = (d, h) => new Date(2026, 9, d, h, 0).getTime();
  const samples = [
    { t: at(19, 10), k: kid, c: 'CNY', v: 100 },
    { t: at(19, 12), k: kid, c: 'CNY', v: 98.5 },
    { t: at(20, 9), k: kid, c: 'CNY', v: 97.25 },
    { t: at(20, 10), k: kid, c: 'CNY', v: 147.25 },
    { t: at(20, 11), k: kid, c: 'CNY', v: 146.95 },
    { t: at(20, 11), k: 'other', c: 'CNY', v: 1 },
  ];
  const s = computeSpend(samples, { kid, currency: 'CNY', now });
  assert.equal(s.today, 1.55);
  assert.equal(s.month, 3.05);
  assert.equal(s.monthTopups, 50);
  assert.equal(s.daily.length, 7);
  assert.equal(s.daily[6].v, 1.55);
  assert.equal(s.daily[5].v, 1.5);
  assert.equal(s.since, at(19, 10));
});

test('deepseek: 余额不变时不会无限追加快照', () => {
  let samples = [];
  const b = [{ currency: 'CNY', total: 10 }];
  for (let i = 0; i < 50; i++) samples = recordSnapshot(samples, { now: 1e12 + i * 5 * MIN, kid: 'k', balances: b });
  assert.equal(samples.length, 2);
  samples = recordSnapshot(samples, { now: 1e12 + 300 * MIN, kid: 'k', balances: [{ currency: 'CNY', total: 9.5 }] });
  assert.equal(samples.length, 3);
});

test('deepseek: 解析官方余额接口', () => {
  const r = parseBalance({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
  });
  assert.deepEqual(r, { available: true, balances: [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }] });
});

test('动画表与 Codex 一致：非 idle 动作播 3 遍再接慢速 idle', () => {
  const tl = QP.timeline('waving');
  assert.equal(tl.loopStart, 12);
  assert.equal(tl.frames[0].row, 3);
  assert.equal(tl.frames[12].row, 0);
  assert.equal(tl.frames[12].ms, 280 * 6);
  assert.equal(QP.timeline('running', { loop: true }).frames.length, 6);
  assert.equal(QP.timeline('idle', { reduced: true }).frames.length, 1);
});

test('看向帧：正上方是第 10 行第 1 帧，正下方是第 11 行第 1 帧', () => {
  assert.deepEqual(QP.lookFrame(0, -10), { row: 9, col: 0, ms: 0 });
  assert.deepEqual(QP.lookFrame(10, 0), { row: 9, col: 4, ms: 0 });
  assert.deepEqual(QP.lookFrame(0, 10), { row: 10, col: 0, ms: 0 });
  assert.deepEqual(QP.lookFrame(-10, 0), { row: 10, col: 4, ms: 0 });
});

test('告警：剩余低于阈值、DeepSeek 余额低', () => {
  const snap = {
    codex: { status: 'ok', data: { windows: [{ key: 'primary', windowMins: 300, usedPercent: 95, resetsAt: null }] } },
    claude: { status: 'off' },
    deepseek: { status: 'ok', data: { available: true, balances: [{ currency: 'CNY', total: 3.2 }] } },
  };
  const a = QP.alerts(snap, { alertPercent: 10, lowBalance: 10 });
  assert.deepEqual(
    a.map((x) => x.key),
    ['codex:primary', 'deepseek:low:CNY']
  );
  assert.match(a[0].text, /只剩 5%/);
});

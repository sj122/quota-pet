'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const providerFile = path.resolve(__dirname, '../src/providers/codex.js');
const source = fs.readFileSync(providerFile, 'utf8');
const realRequire = createRequire(providerFile);
const wham = {
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1792494712 },
    secondary_window: { used_percent: 34, limit_window_seconds: 604800, reset_at: 1792955930 },
  },
  rate_limit_reset_credits: { available_count: 3 },
};
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const creditList = {
  credits: [
    { status: 'available', expires_at: '2026-11-06T23:00:07.890890Z' },
    { status: 'redeemed', expires_at: '2026-10-25T00:00:00Z' },
    { status: 'available', expires_at: '2026-10-29T18:34:21.239135Z' },
    { status: 'available', expires_at: '2026-11-12T08:00:00Z' },
  ],
  available_count: 3,
};
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const appServerResult = {
  rateLimits: {
    planType: 'plus',
    primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1792494712 },
    secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: 1792955930 },
  },
};

// 隔离真实凭据和进程，检查刷新是否会启动 codex 以及失败时的恢复行为。
function harness({ auth = { tokens: { access_token: 'test-token', account_id: 'test-account' } }, authError, serverError } = {}) {
  const stats = { reads: 0, lookups: 0, spawns: 0, kills: 0, methods: [] };
  const mockFs = {
    readFileSync(file) {
      assert.equal(file, path.join('/codex-home', 'auth.json'));
      stats.reads++;
      if (authError) throw new Error(authError);
      return JSON.stringify(auth);
    },
    existsSync(file) {
      stats.lookups++;
      return file === 'codex.exe';
    },
  };
  function spawn(exe, args, options) {
    assert.equal(exe, 'codex.exe');
    assert.deepEqual(Array.from(args), ['app-server']);
    assert.equal(options.windowsHide, true);
    stats.spawns++;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = child.stderr.setEncoding = () => {};
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    child.stdin.write = (line) => {
      const message = JSON.parse(line);
      stats.methods.push(message.method);
      if (message.id == null) return;
      const reply = message.id === 0
        ? { id: 0, result: {} }
        : serverError
          ? { id: 1, error: { message: serverError } }
          : { id: 1, result: appServerResult };
      process.nextTick(() => child.stdout.emit('data', JSON.stringify(reply) + '\n'));
    };
    child.kill = () => { stats.kills++; };
    return child;
  }
  function requireMock(name) {
    if (name === 'fs') return mockFs;
    if (name === 'child_process') return { spawn };
    if (name === '../paths') return { codexHome: '/codex-home', localAppData: '/local-app-data' };
    return realRequire(name);
  }
  const module = { exports: {} };
  vm.runInNewContext(source, { require: requireMock, module, setTimeout, clearTimeout, process }, { filename: providerFile });
  return { fetchCodex: module.exports.fetchCodex, stats, auth };
}

test('codex: 令牌查询成功时完全不查找或启动 codex.exe', async () => {
  const { fetchCodex, stats } = harness();
  const urls = [];
  const result = await fetchCodex({
    codexPath: 'codex.exe',
    fetchImpl: async (url, options) => {
      urls.push(url);
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      assert.equal(options.headers['ChatGPT-Account-Id'], 'test-account');
      assert.equal(options.redirect, 'error');
      return ok(url === CREDITS_URL ? creditList : wham);
    },
  });
  assert.deepEqual(urls, [USAGE_URL, CREDITS_URL]);
  assert.equal(result.source, 'http');
  assert.equal(result.windows[0].usedPercent, 12);
  assert.equal(result.windows[1].resetsAt, 1792955930000);
  assert.equal(result.resetCredits.count, 3);
  assert.deepEqual(Array.from(result.resetCredits.expiries), [
    Date.parse('2026-10-29T18:34:21.239Z'),
    Date.parse('2026-11-06T23:00:07.890Z'),
    Date.parse('2026-11-12T08:00:00Z'),
  ]);
  assert.equal(stats.lookups, 0);
  assert.equal(stats.spawns, 0);
});

test('codex: 每次刷新重读登录缓存，跟随 Codex 自身更新的令牌和账号', async () => {
  const { fetchCodex, stats, auth } = harness();
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push([options.headers.Authorization, options.headers['ChatGPT-Account-Id']]);
    return ok(url === CREDITS_URL ? creditList : wham);
  };
  await fetchCodex({ fetchImpl });
  auth.tokens.access_token = 'updated-test-token';
  auth.tokens.account_id = 'updated-test-account';
  await fetchCodex({ fetchImpl });
  assert.deepEqual(seen, [
    ['Bearer test-token', 'test-account'],
    ['Bearer test-token', 'test-account'],
    ['Bearer updated-test-token', 'updated-test-account'],
    ['Bearer updated-test-token', 'updated-test-account'],
  ]);
  assert.equal(stats.reads, 2);
  assert.equal(stats.spawns, 0);
});

test('codex: 重置卡到期时间查不到时照常显示额度和卡数', async (t) => {
  const failures = [
    ['网络错误', async () => { throw new Error('网络错误'); }],
    ['HTTP 500', async () => ({ ok: false, status: 500 })],
  ];
  for (const [name, fail] of failures) {
    await t.test(name, async () => {
      const { fetchCodex, stats } = harness();
      const result = await fetchCodex({
        codexPath: 'codex.exe',
        fetchImpl: async (url) => (url === CREDITS_URL ? fail() : ok(wham)),
      });
      assert.equal(result.source, 'http');
      assert.equal(result.windows[0].usedPercent, 12);
      assert.equal(result.resetCredits.count, 3);
      assert.equal(result.resetCredits.expiries.length, 0);
      assert.equal(stats.spawns, 0);
    });
  }
});

test('codex: 没有重置卡时不再多查一次', async () => {
  const { fetchCodex } = harness();
  const urls = [];
  const result = await fetchCodex({
    fetchImpl: async (url) => {
      urls.push(url);
      return ok({ ...wham, rate_limit_reset_credits: { available_count: 0 } });
    },
  });
  assert.deepEqual(urls, [USAGE_URL]);
  assert.equal(result.resetCredits, null);
});

test('codex: 直连失败后才启动一次后台备用查询，查询完即关闭', async (t) => {
  const failures = [
    ['网络超时', async () => { throw new Error('网络超时'); }],
    ['登录令牌已失效', async () => ({ ok: false, status: 401 })],
    ['拒绝访问', async () => ({ ok: false, status: 403 })],
    ['HTTP 503', async () => ({ ok: false, status: 503 })],
    ['没有返回额度信息', async () => ({ ok: true, status: 200, json: async () => ({}) })],
  ];
  for (const [message, fail] of failures) {
    await t.test(message, async () => {
      const { fetchCodex, stats } = harness();
      let requests = 0;
      const result = await fetchCodex({
        codexPath: 'codex.exe',
        fetchImpl: async () => {
          assert.equal(stats.spawns, 0);
          requests++;
          return fail();
        },
      });
      assert.equal(result.source, 'app-server');
      assert.equal(result.windows[0].usedPercent, 12);
      assert.ok(result.note.includes(message));
      assert.equal(requests, 1);
      assert.equal(stats.spawns, 1);
      assert.equal(stats.kills, 1);
      assert.deepEqual(stats.methods, ['initialize', 'initialized', 'account/rateLimits/read']);
    });
  }
});

test('codex: 登录信息缺失或仅 API Key 登录时不发送无效的 HTTP 请求', async (t) => {
  for (const options of [{ authError: 'ENOENT' }, { auth: { OPENAI_API_KEY: 'test-key' } }]) {
    await t.test(options.authError || 'API Key', async () => {
      const { fetchCodex, stats } = harness(options);
      const result = await fetchCodex({
        codexPath: 'codex.exe',
        fetchImpl: async () => assert.fail('没有订阅令牌时不应发请求'),
      });
      assert.equal(result.source, 'app-server');
      assert.equal(stats.spawns, 1);
      assert.equal(stats.kills, 1);
    });
  }
});

test('codex: 直连失败且没有 codex 程序时给出可诊断错误', async () => {
  const { fetchCodex, stats } = harness();
  await assert.rejects(fetchCodex({
    codexPath: 'missing.exe',
    fetchImpl: async () => ({ ok: false, status: 401 }),
  }), /登录令牌已失效.*未找到 codex 程序/);
  assert.equal(stats.spawns, 0);
});

test('codex: 两条通路都失败时保留两边原因并关闭后台进程', async () => {
  const { fetchCodex, stats } = harness({ serverError: '备用服务不可用' });
  await assert.rejects(fetchCodex({
    codexPath: 'codex.exe',
    fetchImpl: async () => ({ ok: false, status: 503 }),
  }), /HTTP 503.*备用服务不可用/);
  assert.equal(stats.spawns, 1);
  assert.equal(stats.kills, 1);
});

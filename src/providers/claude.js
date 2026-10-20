'use strict';

const fs = require('fs');
const path = require('path');
const { claudeConfigDir, claudeDesktopDir } = require('../paths');

const CLIENT_VERSION = require('../../package.json').version;
const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const DESKTOP_HISTORY_FILE = path.join(claudeDesktopDir, 'plan-usage-history.json');
const FIVE_HOURS = 5 * 3600e3;
const SEVEN_DAYS = 7 * 86400e3;

// ---------- 通路一：Claude Code CLI 的登录凭据（精确值 + 精确重置时间） ----------

function readOAuthCredentials() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(claudeConfigDir, '.credentials.json'), 'utf8'));
    const o = j.claudeAiOauth || {};
    if (!o.accessToken) return null;
    return { accessToken: o.accessToken, expiresAt: o.expiresAt || null, plan: o.subscriptionType || null };
  } catch {
    return null;
  }
}

const OAUTH_WINDOWS = [
  ['five_hour', 300, null],
  ['seven_day', 10080, null],
  ['seven_day_sonnet', 10080, 'Sonnet'],
  ['seven_day_opus', 10080, 'Opus'],
];

function normalizeOAuthUsage(j, plan = null) {
  const windows = [];
  for (const [key, windowMins, model] of OAUTH_WINDOWS) {
    const w = j && j[key];
    if (!w || typeof w.utilization !== 'number') continue;
    windows.push({
      key,
      windowMins,
      model,
      usedPercent: w.utilization,
      resetsAt: w.resets_at ? Date.parse(w.resets_at) : null,
    });
  }
  if (!windows.length) throw new Error('Claude 接口没有返回额度信息');
  return { source: 'oauth', plan, windows };
}

// 只读：令牌过期就退回桌面端数据，不自己刷新令牌。
async function readViaOAuth(cred, fetchImpl) {
  const res = await fetchImpl(OAUTH_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${cred.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      Accept: 'application/json',
      'User-Agent': `quota-pet/${CLIENT_VERSION}`,
    },
  });
  if (res.status === 401) throw new Error('Claude Code 登录令牌已失效');
  if (res.status === 403) throw new Error('Claude Code 令牌没有读取用量的权限');
  if (!res.ok) throw new Error(`Claude 接口返回 HTTP ${res.status}`);
  return normalizeOAuthUsage(await res.json(), cred.plan);
}

// ---------- 通路二：Claude 桌面端自己记录的用量采样 ----------
// %APPDATA%\Claude\plan-usage-history.json 形如
// {"version":2,"samples":[{"t":毫秒,"org":"...","u":{"fh":5小时%,"sd":7天%}}]}

function readDesktopSamples(file = DESKTOP_HISTORY_FILE) {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  return (Array.isArray(j.samples) ? j.samples : [])
    .filter((s) => s && typeof s.t === 'number' && s.u && (typeof s.u.fh === 'number' || typeof s.u.sd === 'number'))
    .map((s) => ({
      t: s.t,
      org: s.org || null,
      fh: typeof s.u.fh === 'number' ? s.u.fh : null,
      sd: typeof s.u.sd === 'number' ? s.u.sd : null,
    }));
}

// 桌面端只保留最近十几个采样点，这里合并进自己的历史，便于推算窗口起点。
function mergeSamples(stored, incoming, cap = 4000) {
  const byTime = new Map();
  for (const s of stored) byTime.set(s.t, s);
  for (const s of incoming) byTime.set(s.t, s);
  return [...byTime.values()].sort((a, b) => a.t - b.t).slice(-cap);
}

// 推算当前窗口的重置时间：往回找当前窗口的第一个采样点，窗口起点落在它和前一个点之间。
// 返回 { at, kind: 'about' | 'latest' }；kind=latest 表示只知道“最晚这个时间重置”。
function estimateReset(samples, key, windowMs) {
  const s = samples.filter((x) => typeof x[key] === 'number');
  if (!s.length) return null;
  let i = s.length - 1;
  if (s[i][key] <= 0) return null;
  while (i > 0) {
    const prev = s[i - 1];
    const cur = s[i];
    if (prev[key] <= 0) break;
    if (prev[key] > cur[key] + 1) break;
    if (cur.t - prev.t >= windowMs) break;
    i--;
  }
  const hi = s[i].t;
  const lo = i > 0 ? s[i - 1].t : null;
  if (lo != null && hi - lo <= 30 * 60e3) return { at: Math.round((lo + hi) / 2) + windowMs, kind: 'about' };
  return { at: hi + windowMs, kind: 'latest' };
}

function fromDesktop(samples) {
  const latest = samples[samples.length - 1];
  const mine = samples.filter((s) => s.org === latest.org);
  const windows = [];
  if (typeof latest.fh === 'number') {
    windows.push({ key: 'five_hour', windowMins: 300, usedPercent: latest.fh, estimate: estimateReset(mine, 'fh', FIVE_HOURS) });
  }
  if (typeof latest.sd === 'number') {
    // 周窗口的起点通常早于本地采样范围，只有亲眼看到过起点/重置时才给估算
    const est = estimateReset(mine, 'sd', SEVEN_DAYS);
    windows.push({ key: 'seven_day', windowMins: 10080, usedPercent: latest.sd, estimate: est && est.kind === 'about' ? est : null });
  }
  return { source: 'desktop', plan: null, sampledAt: latest.t, windows };
}

async function fetchClaude({ fetchImpl, historyStore }) {
  const cred = readOAuthCredentials();
  let note = null;
  if (cred) {
    if (cred.expiresAt && cred.expiresAt < Date.now() + 30e3) {
      note = 'Claude Code 登录令牌已过期，暂用桌面端记录';
    } else {
      try {
        return await readViaOAuth(cred, fetchImpl);
      } catch (e) {
        note = `${e.message}，暂用桌面端记录`;
      }
    }
  }

  const stored = historyStore.read();
  const before = Array.isArray(stored.samples) ? stored.samples : [];
  const samples = mergeSamples(before, readDesktopSamples());
  const last = (arr) => (arr.length ? arr[arr.length - 1].t : 0);
  if (samples.length !== before.length || last(samples) !== last(before)) historyStore.write({ samples });
  if (!samples.length) {
    throw new Error('还没有 Claude 额度数据：用订阅账号登录 Claude 桌面端后会自动记录，或在终端运行 claude 登录 Claude Code');
  }
  return { ...fromDesktop(samples), note };
}

module.exports = {
  fetchClaude,
  normalizeOAuthUsage,
  readDesktopSamples,
  mergeSamples,
  estimateReset,
  fromDesktop,
  DESKTOP_HISTORY_FILE,
};

'use strict';

const crypto = require('crypto');

const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const KEEP_MS = 120 * 86400e3;

// 只用 key 的哈希区分账号，历史文件里不落明文 key。
function keyId(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 12);
}

function parseBalance(j) {
  const balances = (Array.isArray(j && j.balance_infos) ? j.balance_infos : []).map((b) => ({
    currency: String(b.currency || 'CNY'),
    total: Number(b.total_balance) || 0,
    granted: Number(b.granted_balance) || 0,
    toppedUp: Number(b.topped_up_balance) || 0,
  }));
  return { available: Boolean(j && j.is_available), balances };
}

const round = (v) => Math.round(v * 10000) / 10000;

// 记一笔余额快照。余额没变时只把这一段的结束时间往后挪，连续不变的余额只占两个点。
function recordSnapshot(samples, { now, kid, balances }) {
  const out = samples.filter((s) => now - s.t < KEEP_MS);
  for (const b of balances) {
    const v = round(b.total);
    const series = out.filter((s) => s.k === kid && s.c === b.currency);
    const last = series[series.length - 1];
    const prev = series[series.length - 2];
    if (last && last.v === v && prev && prev.v === v) last.t = now;
    else if (!last || last.v !== v || now - last.t >= 60e3) out.push({ t: now, k: kid, c: b.currency, v });
  }
  return out;
}

function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfMonth(t) {
  const d = new Date(t);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 用余额下降量推算消费：相邻两个快照之间余额减少的部分算作消费，增加的部分算作充值。
function computeSpend(samples, { kid, currency, now = Date.now(), days = 7 }) {
  const s = samples.filter((x) => x.k === kid && x.c === currency).sort((a, b) => a.t - b.t);
  const today0 = startOfDay(now);
  const month0 = startOfMonth(now);
  const daily = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today0);
    d.setDate(d.getDate() - i);
    daily.push({ t: d.getTime(), v: 0 });
  }
  let today = 0;
  let month = 0;
  let monthTopups = 0;
  for (let i = 1; i < s.length; i++) {
    const diff = round(s[i - 1].v - s[i].v);
    const t = s[i].t;
    if (diff < 0) {
      if (t >= month0) monthTopups += -diff;
      continue;
    }
    if (diff === 0) continue;
    if (t >= today0) today += diff;
    if (t >= month0) month += diff;
    for (let j = daily.length - 1; j >= 0; j--) {
      if (t >= daily[j].t) {
        daily[j].v += diff;
        break;
      }
    }
  }
  return {
    today: round(today),
    month: round(month),
    monthTopups: round(monthTopups),
    daily: daily.map((d) => ({ t: d.t, v: round(d.v) })),
    since: s.length ? s[0].t : null,
  };
}

async function requestBalance(key, fetchImpl) {
  const res = await fetchImpl(BALANCE_URL, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  if (res.status === 401) {
    const err = new Error('API Key 无效或已被删除（HTTP 401）');
    err.code = 'unauthorized';
    throw err;
  }
  if (!res.ok) throw new Error(`DeepSeek 接口返回 HTTP ${res.status}`);
  return parseBalance(await res.json());
}

async function fetchDeepseek({ key, fetchImpl, historyStore, now = Date.now() }) {
  if (!key) return { needsKey: true };
  const parsed = await requestBalance(key, fetchImpl);
  const kid = keyId(key);
  const stored = historyStore.read();
  const samples = recordSnapshot(Array.isArray(stored.samples) ? stored.samples : [], { now, kid, balances: parsed.balances });
  historyStore.write({ samples });
  const spend = {};
  for (const b of parsed.balances) spend[b.currency] = computeSpend(samples, { kid, currency: b.currency, now });
  return { ...parsed, spend };
}

module.exports = {
  fetchDeepseek,
  requestBalance,
  parseBalance,
  recordSnapshot,
  computeSpend,
  keyId,
  startOfDay,
  startOfMonth,
};

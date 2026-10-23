'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { codexHome, localAppData } = require('../paths');

const CLIENT_VERSION = require('../../package.json').version;
const WHAM_URL = 'https://chatgpt.com/backend-api/wham';

// 依次查找 codex 可执行文件：手动指定 > Codex 桌面端自带的 bin（取最新的） > PATH。
function findCodexExe(override) {
  if (override) return fs.existsSync(override) ? override : null;
  const binRoot = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  const found = [];
  try {
    for (const name of fs.readdirSync(binRoot)) {
      const exe = path.join(binRoot, name, 'codex.exe');
      try {
        found.push({ exe, mtime: fs.statSync(exe).mtimeMs });
      } catch {}
    }
  } catch {}
  found.sort((a, b) => b.mtime - a.mtime);
  if (found.length) return found[0].exe;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const name of ['codex.exe', 'codex.cmd']) {
      const file = path.join(dir, name);
      if (dir && fs.existsSync(file)) return file;
    }
  }
  return null;
}

// 启动一次 `codex app-server`，走官方 JSON-RPC 读取额度。令牌刷新、代理都由 codex 自己处理。
function readViaAppServer(exe, { timeoutMs = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    const isCmd = /\.cmd$/i.test(exe);
    const child = spawn(isCmd ? `"${exe}"` : exe, ['app-server'], {
      windowsHide: true,
      shell: isCmd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    let stderr = '';
    let done = false;

    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {}
      child.kill();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('codex app-server 响应超时')), timeoutMs);
    const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');

    child.on('error', (e) => finish(new Error(`无法启动 codex：${e.message}`)));
    child.on('exit', (code) => {
      const last = stderr.trim().split(/\r?\n/).pop() || '';
      finish(new Error(`codex app-server 提前退出（code ${code}）${last ? '：' + last.slice(0, 160) : ''}`));
    });
    child.stdin.on('error', () => {});
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-4000);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 0) {
          if (msg.error) return finish(new Error(msg.error.message || 'codex 初始化失败'));
          send({ method: 'initialized' });
          send({ method: 'account/rateLimits/read', id: 1 });
        } else if (msg.id === 1) {
          if (msg.error) return finish(new Error(msg.error.message || '读取 Codex 额度失败'));
          finish(null, msg.result);
        }
      }
    });

    send({
      method: 'initialize',
      id: 0,
      params: { clientInfo: { name: 'quota_pet', title: 'Quota Pet', version: CLIENT_VERSION } },
    });
  });
}

function toWindow(key, w) {
  if (!w || typeof w.usedPercent !== 'number') return null;
  return {
    key,
    usedPercent: w.usedPercent,
    windowMins: w.windowDurationMins ?? null,
    resetsAt: w.resetsAt ? w.resetsAt * 1000 : null,
  };
}

function normalizeAppServer(result) {
  const rl = (result && result.rateLimits) || {};
  const windows = [toWindow('primary', rl.primary), toWindow('secondary', rl.secondary)].filter(Boolean);
  if (!windows.length) throw new Error('当前 Codex 账号没有订阅额度信息（可能是 API Key 登录）');

  // 某些模型会有单独的额度池，一并列出来
  const extras = [];
  for (const [id, lim] of Object.entries(result.rateLimitsByLimitId || {})) {
    if (!lim || id === (rl.limitId || 'codex')) continue;
    const ws = [toWindow('primary', lim.primary), toWindow('secondary', lim.secondary)].filter(Boolean);
    if (ws.length) extras.push({ name: lim.limitName || lim.normalModelSlug || id, windows: ws });
  }

  const credits = ((result.rateLimitResetCredits && result.rateLimitResetCredits.credits) || []).filter(
    (c) => c.status === 'available'
  );
  const expiries = credits.map((c) => c.expiresAt * 1000).filter(Boolean).sort((a, b) => a - b);
  return {
    source: 'app-server',
    plan: rl.planType || null,
    windows,
    extras,
    limitReached: rl.rateLimitReachedType || null,
    resetCredits: credits.length
      ? {
          count: result.rateLimitResetCredits.availableCount ?? credits.length,
          expiries,
        }
      : null,
  };
}

function toWhamWindow(key, w, now) {
  if (!w || typeof w.used_percent !== 'number') return null;
  let resetsAt = null;
  if (w.reset_at) resetsAt = w.reset_at * 1000;
  else if (typeof w.reset_after_seconds === 'number') resetsAt = now + w.reset_after_seconds * 1000;
  return {
    key,
    usedPercent: w.used_percent,
    windowMins: w.limit_window_seconds ? Math.round(w.limit_window_seconds / 60) : null,
    resetsAt,
  };
}

function normalizeWham(j, now = Date.now()) {
  const rl = (j && j.rate_limit) || {};
  const windows = [toWhamWindow('primary', rl.primary_window, now), toWhamWindow('secondary', rl.secondary_window, now)].filter(
    Boolean
  );
  if (!windows.length) throw new Error('Codex 接口没有返回额度信息');
  const rc = j.rate_limit_reset_credits;
  return {
    source: 'http',
    plan: j.plan_type || null,
    windows,
    extras: [],
    limitReached: j.rate_limit_reached_type || (rl.limit_reached ? 'limit' : null),
    resetCredits: rc && rc.available_count ? { count: rc.available_count, expiries: [] } : null,
  };
}

// wham/rate-limit-reset-credits 列出每张重置卡，到期时间是 ISO 字符串。
function normalizeCreditList(j) {
  return ((j && j.credits) || [])
    .filter((c) => c && c.status === 'available')
    .map((c) => Date.parse(c.expires_at))
    .filter(Boolean)
    .sort((a, b) => a - b);
}

// 优先通路：直接用 ~/.codex/auth.json 里的令牌查询，无需启动 codex 进程。
// 只读登录缓存；令牌续期交给备用的官方 app-server 处理。
async function readViaHttp(fetchImpl) {
  let auth;
  try {
    auth = JSON.parse(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8'));
  } catch {
    throw new Error('没找到 Codex 登录信息（~/.codex/auth.json）');
  }
  const t = auth.tokens || {};
  if (!t.access_token) throw new Error('Codex 没有用 ChatGPT 账号登录');
  const get = (url) =>
    fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${t.access_token}`,
        'ChatGPT-Account-Id': t.account_id || '',
        'User-Agent': `quota-pet/${CLIENT_VERSION}`,
        Accept: 'application/json',
      },
      redirect: 'error',
    });
  const res = await get(`${WHAM_URL}/usage`);
  if (res.status === 401) throw new Error('Codex 登录令牌已失效');
  if (res.status === 403) throw new Error('Codex 直连接口拒绝访问');
  if (!res.ok) throw new Error(`Codex 接口返回 HTTP ${res.status}`);
  const data = normalizeWham(await res.json());
  if (data.resetCredits) data.resetCredits.expiries = await readCreditExpiries(get);
  return data;
}

// 用量接口只给重置卡数量，每张卡的到期时间要再查一次；查不到就只显示数量。
async function readCreditExpiries(get) {
  try {
    const res = await get(`${WHAM_URL}/rate-limit-reset-credits`);
    return res.ok ? normalizeCreditList(await res.json()) : [];
  } catch {
    return [];
  }
}

async function fetchCodex({ fetchImpl, codexPath } = {}) {
  let httpError;
  try {
    return await readViaHttp(fetchImpl);
  } catch (e) {
    httpError = e;
  }

  // 仅在令牌缺失、过期或直连接口不可用时才启动一次官方后台进程。
  const exe = findCodexExe(codexPath);
  if (!exe) throw new Error(`Codex 令牌直连失败：${httpError.message}；未找到 codex 程序用于备用查询`);
  try {
    return {
      ...normalizeAppServer(await readViaAppServer(exe)),
      exe,
      note: `令牌直连暂不可用，已通过 codex 后台查询（${httpError.message}）`,
    };
  } catch (e) {
    throw new Error(`Codex 令牌直连失败：${httpError.message}；备用查询也失败：${e.message}`);
  }
}

module.exports = { fetchCodex, findCodexExe, normalizeAppServer, normalizeWham, normalizeCreditList };

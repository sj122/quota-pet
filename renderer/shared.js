// 主进程（require）和各个页面（<script>）共用的纯函数：精灵动画表、格式化、告警规则。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QP = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 精灵动画（与 Codex 桌面端一致） ----------
  // 每行一个动作；数字是每帧毫秒数，最后一帧停留更久。
  const IDLE_BASE = [280, 110, 110, 140, 140, 320];
  const IDLE_SLOW = IDLE_BASE.map((ms, col) => ({ row: 0, col, ms: ms * 6 }));

  function seq(row, count, ms, lastMs) {
    return Array.from({ length: count }, (_, col) => ({ row, col, ms: col === count - 1 ? lastMs : ms }));
  }

  const ANIMS = {
    idle: IDLE_BASE.map((ms, col) => ({ row: 0, col, ms })),
    'running-right': seq(1, 8, 120, 220),
    'running-left': seq(2, 8, 120, 220),
    waving: seq(3, 4, 140, 280),
    jumping: seq(4, 5, 140, 280),
    failed: seq(5, 8, 140, 240),
    waiting: seq(6, 6, 150, 260),
    running: seq(7, 6, 120, 220),
    review: seq(8, 6, 150, 280),
  };

  // 非 idle 动作默认播 3 遍再回到慢速 idle 循环（Codex 的做法）；loop=true 时一直循环。
  function timeline(state, { loop = false, repeat = 3, reduced = false } = {}) {
    const base = ANIMS[state] || ANIMS.idle;
    if (reduced) return { frames: [base[0]], loopStart: null };
    if (state === 'idle') return { frames: IDLE_SLOW, loopStart: 0 };
    if (loop) return { frames: base, loopStart: 0 };
    const played = [];
    for (let i = 0; i < repeat; i++) played.push(...base);
    return { frames: [...played, ...IDLE_SLOW], loopStart: played.length };
  }

  // v2 精灵图第 10、11 行：16 个方向的“看向”帧，0° 朝上、顺时针每 22.5° 一帧。
  function lookFrame(dx, dy) {
    if (Math.hypot(dx, dy) <= 1) return null;
    const angle = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
    const idx = Math.round(angle / 22.5) % 16;
    return { row: 9 + Math.floor(idx / 8), col: idx % 8, ms: 0 };
  }

  // ---------- 格式化 ----------
  const pad2 = (n) => String(n).padStart(2, '0');
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

  function clock(ts) {
    const d = new Date(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function dayStart(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function when(ts, now = Date.now()) {
    const diff = Math.round((dayStart(ts) - dayStart(now)) / 86400e3);
    const d = new Date(ts);
    if (diff === 0) return `今天 ${clock(ts)}`;
    if (diff === 1) return `明天 ${clock(ts)}`;
    if (diff === -1) return `昨天 ${clock(ts)}`;
    return `${d.getMonth() + 1}月${d.getDate()}日 周${WEEK[d.getDay()]} ${clock(ts)}`;
  }

  function duration(ms) {
    if (ms <= 60e3) return '1 分钟内';
    const m = Math.round(ms / 60e3);
    if (m < 60) return `${m} 分钟`;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    if (h < 24) return mm ? `${h} 小时 ${mm} 分` : `${h} 小时`;
    const d = Math.floor(h / 24);
    const hh = h % 24;
    return hh ? `${d} 天 ${hh} 小时` : `${d} 天`;
  }

  function ago(ts, now = Date.now()) {
    const s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 45) return '刚刚';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} 分钟前`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} 小时前`;
    return `${Math.round(h / 24)} 天前`;
  }

  function shortDate(ts) {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${clock(ts)}`;
  }

  function windowLabel(mins, model) {
    let base;
    if (mins === 300) base = '5 小时';
    else if (mins === 10080) base = '每周';
    else if (mins && mins % 1440 === 0) base = `${mins / 1440} 天`;
    else if (mins && mins % 60 === 0) base = `${mins / 60} 小时`;
    else base = mins ? `${mins} 分钟` : '额度';
    return model ? `${base} · ${model}` : base;
  }

  function shortWindowLabel(mins) {
    if (mins === 300) return '5h';
    if (mins === 10080) return '周';
    return windowLabel(mins);
  }

  const remaining = (used) => Math.max(0, Math.min(100, 100 - used));
  const level = (rem) => (rem <= 10 ? 'danger' : rem <= 30 ? 'warn' : 'ok');

  function pct(v) {
    const r = Math.round(v * 10) / 10;
    return Number.isInteger(r) ? `${r}%` : `${r.toFixed(1)}%`;
  }

  const SYMBOL = { CNY: '¥', USD: '$' };
  function money(v, currency = 'CNY') {
    const sym = SYMBOL[currency] || `${currency} `;
    return `${sym}${(Math.round(v * 100) / 100).toFixed(2)}`;
  }

  // 重置时间的描述：精确值 / 桌面端推算值 / 未知
  function resetText(w, now = Date.now()) {
    if (w.resetsAt) {
      const left = w.resetsAt - now;
      if (left <= 0) return '已到重置时间';
      return `${duration(left)}后重置 · ${when(w.resetsAt, now)}`;
    }
    const e = w.estimate;
    if (e) {
      if (e.at <= now) return '窗口应该已经重置';
      return e.kind === 'about' ? `预计${when(e.at, now)} 重置` : `最晚${when(e.at, now)} 重置`;
    }
    if (w.usedPercent <= 0) return '还没开始计时';
    return '重置时间未知';
  }

  // ---------- 汇总与告警 ----------
  const NAMES = { codex: 'Codex', claude: 'Claude', deepseek: 'DeepSeek' };

  function providerSummary(name, slot) {
    if (!slot || slot.status === 'off') return null;
    const d = slot.data;
    if (!d) {
      if (slot.status === 'error') return `${NAMES[name]}　读取失败`;
      return `${NAMES[name]}　读取中…`;
    }
    if (name === 'deepseek') {
      if (d.needsKey) return 'DeepSeek　未设置 Key';
      return `DeepSeek　${d.balances.map((b) => money(b.total, b.currency)).join(' / ') || '无余额'}`;
    }
    const parts = d.windows
      .filter((w) => !w.model)
      .map((w) => `${shortWindowLabel(w.windowMins)} ${pct(remaining(w.usedPercent))}`);
    return `${NAMES[name]}　剩余 ${parts.join(' · ')}`;
  }

  function summaryLines(snap) {
    return ['codex', 'claude', 'deepseek'].map((n) => providerSummary(n, snap && snap[n])).filter(Boolean);
  }

  function alerts(snap, cfg, now = Date.now()) {
    const out = [];
    const limit = (cfg && cfg.alertPercent) || 10;
    for (const name of ['codex', 'claude']) {
      const slot = snap && snap[name];
      const d = slot && slot.data;
      if (!d || slot.status === 'off' || !Array.isArray(d.windows)) continue;
      for (const w of d.windows) {
        const rem = remaining(w.usedPercent);
        if (rem > limit) continue;
        const reset = w.resetsAt && w.resetsAt > now ? `，${when(w.resetsAt, now)} 重置` : '';
        const label = w.model ? `${w.model} 每周额度` : `${windowLabel(w.windowMins)}额度`;
        out.push({
          key: `${name}:${w.key}`,
          text: `${NAMES[name]} ${label}只剩 ${pct(rem)}${reset}`,
        });
      }
    }
    const ds = snap && snap.deepseek;
    if (ds && ds.data && ds.status !== 'off' && !ds.data.needsKey) {
      if (!ds.data.available) {
        out.push({ key: 'deepseek:unavailable', text: 'DeepSeek 余额不足，API 已不可用' });
      } else {
        const low = cfg && typeof cfg.lowBalance === 'number' ? cfg.lowBalance : 10;
        for (const b of ds.data.balances) {
          if (b.total <= low) out.push({ key: `deepseek:low:${b.currency}`, text: `DeepSeek 余额只剩 ${money(b.total, b.currency)}` });
        }
      }
    }
    return out;
  }

  // ---------- 宠物的反应：头顶小图标、额度回满、回来汇报、看场合说话 ----------

  // 订阅额度窗口（Codex / Claude），name 是服务名
  function subscriptionWindows(snap, { models = true } = {}) {
    const out = [];
    for (const name of ['codex', 'claude']) {
      const slot = snap && snap[name];
      const d = slot && slot.data;
      if (!d || slot.status === 'off' || !Array.isArray(d.windows)) continue;
      for (const w of d.windows) if (models || !w.model) out.push({ name, w });
    }
    return out;
  }

  const windowName = (name, w) => `${NAMES[name]} ${w.model ? `${w.model} 每周` : windowLabel(w.windowMins)}额度`;

  // 头顶小图标：error 全部读取失败；danger 有额度告急；warn 有订阅额度只剩三成以内
  function mood(snap, cfg, now = Date.now()) {
    const slots = ['codex', 'claude', 'deepseek'].map((n) => snap && snap[n]).filter((s) => s && s.status !== 'off');
    if (slots.length && slots.every((s) => s.status === 'error')) return 'error';
    if (alerts(snap, cfg, now).length) return 'danger';
    if (subscriptionWindows(snap, { models: false }).some(({ w }) => remaining(w.usedPercent) <= 30)) return 'warn';
    return 'ok';
  }

  // 同一个窗口的上一次和这一次数据；Claude 桌面端记录和接口直查口径不同，来源变了不比较
  function pairedWindows(prev, next, opts) {
    const out = [];
    for (const { name, w } of subscriptionWindows(next, opts)) {
      const a = prev && prev[name] && prev[name].data;
      if (!a || !Array.isArray(a.windows) || (name === 'claude' && a.source !== next[name].data.source)) continue;
      const old = a.windows.find((x) => x.key === w.key);
      if (old) out.push({ name, w, old, limitReached: Boolean(a.limitReached) });
    }
    return out;
  }

  // 两次快照之间“额度回满”的窗口：原来至少用了 15%，这次降了 10 个百分点以上、只剩 25% 以内的用量
  function resetEvents(prev, next, cfg) {
    const limit = (cfg && cfg.alertPercent) || 10;
    return pairedWindows(prev, next)
      .filter(({ w, old }) => old.usedPercent >= 15 && w.usedPercent <= old.usedPercent - 10 && w.usedPercent <= 25)
      .map(({ name, w, old, limitReached }) => {
        const rem = remaining(w.usedPercent);
        return {
          key: `${name}:${w.key}`,
          text: rem >= 95 ? `${windowName(name, w)}回满啦` : `${windowName(name, w)}重置啦，剩 ${pct(rem)}`,
          wasLow: limitReached || remaining(old.usedPercent) <= limit,
        };
      });
  }

  // 离开期间的变化：额度重置、又被用掉多少（比如 Agent 在后台跑）、DeepSeek 花了多少
  function awayReport(before, after) {
    const lines = [];
    for (const { name, w, old } of pairedWindows(before, after, { models: false })) {
      if (old.usedPercent >= 5 && w.usedPercent <= old.usedPercent - 10) lines.push(`${windowName(name, w)}已经重置`);
      else if (w.usedPercent - old.usedPercent >= 5) lines.push(`期间 ${windowName(name, w)}又用了 ${pct(w.usedPercent - old.usedPercent)}`);
    }
    const a = before && before.deepseek && before.deepseek.data;
    const b = after && after.deepseek && after.deepseek.data;
    if (a && b && Array.isArray(a.balances) && Array.isArray(b.balances) && after.deepseek.status !== 'off') {
      for (const bal of b.balances) {
        const old = a.balances.find((x) => x.currency === bal.currency);
        if (old && old.total - bal.total >= 0.01) lines.push(`期间 DeepSeek 花了 ${money(old.total - bal.total, bal.currency)}`);
      }
    }
    return lines;
  }

  function greeting(now = Date.now()) {
    const h = new Date(now).getHours();
    const hi = h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好';
    return [`${hi}！我来帮你盯着额度啦～`, '点我看看详情'];
  }

  // 看场合挑台词的候选：时间段、星期、额度松紧都会影响；weight 越大越容易被挑中。每行尽量不超过 17 个字。
  function chatterLines(snap, cfg, now = Date.now()) {
    const d = new Date(now);
    const h = d.getHours();
    const mins = h * 60 + d.getMinutes();
    const day = d.getDay();
    const out = [];
    const add = (weight, ...lines) => out.push({ weight, lines });

    if (h >= 6 && h < 9) add(2, '早上好～今天也一起加油');
    if (mins >= 690 && mins < 780) add(2, '到饭点啦，先去吃饭吧');
    if (h === 15) add(1, '下午三点，起来活动一下～');
    if (h >= 23) add(2, '已经 23 点多了，早点休息');
    if (h < 5) add(3, `${h} 点了还不睡吗…`, '额度明天还会有的');
    if (day === 5 && h >= 17) add(2, '周五啦，周末愉快～');
    if ((day === 0 || day === 6) && h >= 9 && h < 22) add(1, '周末也在写代码呀');

    const limit = (cfg && cfg.alertPercent) || 10;
    const wins = subscriptionWindows(snap, { models: false });
    for (const { name, w } of wins) {
      const rem = remaining(w.usedPercent);
      const left = w.resetsAt ? w.resetsAt - now : null;
      if (w.windowMins === 300 && rem <= 40 && left > 0 && left <= 45 * 60e3) {
        add(3, `${windowName(name, w)}只剩 ${pct(rem)}`, `${duration(left)}后就重置啦`);
      } else if (rem <= 30 && rem > limit) {
        add(3, `${windowName(name, w)}只剩 ${pct(rem)}`, '省着点用～');
      }
      if (w.windowMins === 10080 && left > 0) {
        if (left <= 36 * 3600e3 && rem >= 40) add(3, `${windowName(name, w)}还剩 ${pct(rem)}`, `${duration(left)}后重置，别浪费～`);
        if (day === 1 && h >= 8 && h < 12 && rem >= 90) add(2, `新的一周，${NAMES[name]} 周额度满格！`);
      }
    }
    if (wins.length && wins.every(({ w }) => remaining(w.usedPercent) >= 70)) add(1, '额度很充足，放心用～');

    const ds = snap && snap.deepseek;
    const low = cfg && typeof cfg.lowBalance === 'number' ? cfg.lowBalance : 10;
    if (ds && ds.data && ds.status !== 'off' && Array.isArray(ds.data.balances)) {
      for (const b of ds.data.balances) {
        if (b.total > low && b.total <= low * 2) add(2, `DeepSeek 余额 ${money(b.total, b.currency)}`, '记得找时间充值～');
      }
    }

    add(1, '我在帮你盯着额度哦');
    add(1, '在我头上来回蹭蹭试试？');
    add(1, '快速甩一下，能把我扔出去哦');
    return out;
  }

  // 按权重随机挑一条，尽量不和上一条重复
  function pickLine(candidates, rand = Math.random, last = '') {
    const fresh = candidates.filter((c) => c.lines.join('') !== last);
    const list = fresh.length ? fresh : candidates;
    let r = rand() * list.reduce((sum, c) => sum + c.weight, 0);
    for (const c of list) {
      r -= c.weight;
      if (r < 0) return c;
    }
    return list[list.length - 1] || null;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  return {
    ANIMS,
    timeline,
    lookFrame,
    clock,
    when,
    duration,
    ago,
    shortDate,
    windowLabel,
    remaining,
    level,
    pct,
    money,
    resetText,
    summaryLines,
    alerts,
    mood,
    resetEvents,
    awayReport,
    greeting,
    chatterLines,
    pickLine,
    escapeHtml,
    NAMES,
    WEEK,
  };
});

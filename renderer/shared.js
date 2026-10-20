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
    escapeHtml,
    NAMES,
    WEEK,
  };
});

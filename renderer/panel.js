(() => {
  'use strict';

  const api = window.quotaPet;
  const QP = window.QP;
  const esc = QP.escapeHtml;
  const $ = (id) => document.getElementById(id);
  const card = $('card');
  const list = $('list');
  const sub = $('sub');
  const footText = $('foot-text');
  const themeSeg = $('theme-seg');
  const avatar = $('avatar');
  const refreshBtn = $('btn-refresh');

  const COLORS = { codex: 'var(--codex)', claude: 'var(--claude)', deepseek: 'var(--deepseek)' };
  let quota = null;
  let config = {};

  const planName = (p) => (p ? String(p).charAt(0).toUpperCase() + String(p).slice(1) : '');

  function meterLabel(w) {
    if (w.model) return `${w.model} 每周`;
    return `${QP.windowLabel(w.windowMins)}额度`;
  }

  function meter(w, now, label) {
    const rem = QP.remaining(w.usedPercent);
    const lv = QP.level(rem);
    return `
      <div class="meter" data-level="${lv}">
        <div class="meter-row">
          <span class="meter-label">${esc(label || meterLabel(w))}</span>
          <span class="meter-value"><b>${QP.pct(rem).replace('%', '')}</b><i>%</i><em>剩余</em></span>
        </div>
        <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(rem)}">
          <span style="width:${rem}%"></span>
        </div>
        <div class="meter-foot">
          <span>已用 ${QP.pct(w.usedPercent)}</span>
          <span class="reset">${esc(QP.resetText(w, now))}</span>
        </div>
      </div>`;
  }

  const note = (text, tone = '') => `<div class="note ${tone}">${esc(text)}</div>`;

  // 悬停重置卡时浮出每张卡的到期时间和剩余时长
  function creditTip(expiries, now) {
    if (!expiries || !expiries.length) return '';
    const rows = expiries
      .map((t) => `<span>${esc(QP.when(t, now))}</span><b>${t > now ? `还剩 ${esc(QP.duration(t - now))}` : '已到期'}</b>`)
      .join('');
    return `<span class="tip" role="tooltip"><span class="tip-title">重置卡到期时间</span>${rows}</span>`;
  }

  function codexBody(d, now) {
    let html = d.windows.map((w) => meter(w, now)).join('');
    for (const ex of d.extras || []) {
      html += ex.windows.map((w) => meter(w, now, `${ex.name} · ${QP.windowLabel(w.windowMins)}`)).join('');
    }
    const chips = [];
    if (d.limitReached) chips.push('<span class="chip danger">已触发限额</span>');
    if (d.resetCredits && d.resetCredits.count) {
      chips.push(`<span class="chip">可用重置卡 ×${d.resetCredits.count}${creditTip(d.resetCredits.expiries, now)}</span>`);
    }
    if (chips.length) html += `<div class="chips">${chips.join('')}</div>`;
    if (d.note) html += note(d.note, 'warn');
    return html;
  }

  function claudeBody(d, now) {
    let html = d.windows.map((w) => meter(w, now)).join('');
    if (d.source === 'desktop') {
      if (now - d.sampledAt > 45 * 60e3) {
        html += note(`桌面端最近一次记录在${QP.ago(d.sampledAt, now)}，打开 Claude 桌面端会自动更新`, 'warn');
      } else {
        html += note('数据来自 Claude 桌面端的用量记录（约每 15 分钟一条，手动刷新不会更快），重置时间是推算的');
      }
    }
    if (d.note) html += note(d.note, 'warn');
    return html;
  }

  function spark(daily) {
    const max = Math.max(...daily.map((d) => d.v), 0);
    return daily
      .map((d, i) => {
        const h = max > 0 ? Math.max(8, Math.round((d.v / max) * 100)) : 8;
        const day = new Date(d.t);
        const title = `${day.getMonth() + 1}/${day.getDate()} 周${QP.WEEK[day.getDay()]}：${d.v.toFixed(2)}`;
        return `<span class="${i === daily.length - 1 ? 'today' : ''}" style="height:${h}%" title="${esc(title)}"></span>`;
      })
      .join('');
  }

  function deepseekBody(d, now) {
    if (d.needsKey) {
      return `<div class="empty"><span>还没有设置 DeepSeek API Key</span><button class="link-btn" data-action="settings">去设置</button></div>`;
    }
    if (!d.balances.length) return note('账户里没有余额信息');
    let html = '';
    for (const b of d.balances) {
      const s = (d.spend && d.spend[b.currency]) || null;
      const sym = b.currency === 'USD' ? '$' : b.currency === 'CNY' ? '¥' : `${b.currency} `;
      html += `
        <div class="ds-top">
          <div class="ds-amount"><span class="cur">${esc(sym)}</span>${b.total.toFixed(2)}</div>
          <div class="ds-split">充值 ${QP.money(b.toppedUp, b.currency)}<br />赠金 ${QP.money(b.granted, b.currency)}</div>
        </div>`;
      if (s) {
        html += `
          <div class="ds-stats">
            <div class="stat"><div class="stat-label">今日消费</div><div class="stat-value">${QP.money(s.today, b.currency)}</div></div>
            <div class="stat"><div class="stat-label">本月消费</div><div class="stat-value">${QP.money(s.month, b.currency)}</div></div>
            <div class="stat"><div class="stat-label">近 7 天</div><div class="spark">${spark(s.daily)}</div></div>
          </div>`;
        const parts = [];
        const month0 = new Date(now);
        month0.setDate(1);
        month0.setHours(0, 0, 0, 0);
        if (s.since && s.since > month0.getTime()) parts.push(`从 ${QP.shortDate(s.since)} 开始统计`);
        parts.push('消费按余额变化推算');
        if (s.monthTopups > 0) parts.push(`本月充值 ${QP.money(s.monthTopups, b.currency)}`);
        html += note(parts.join(' · '));
      }
    }
    return html;
  }

  function skeleton() {
    return '<div class="skel"></div><div class="skel short"></div><div class="skel"></div>';
  }

  function head(name, slot, now) {
    const d = slot.data;
    let tag = '';
    let meta = '';
    let metaClass = '';
    if (name === 'deepseek' && d && !d.needsKey) {
      tag = d.available ? '<span class="tag ok">可用</span>' : '<span class="tag danger">余额不足</span>';
    } else if (d && d.plan) {
      tag = `<span class="tag">${esc(planName(d.plan))}</span>`;
    }
    if (slot.status === 'loading') meta = d ? '刷新中…' : '读取中…';
    else if (slot.status === 'error') {
      meta = d ? '刷新失败' : '读取失败';
      metaClass = 'err';
    } else if (name === 'claude' && d && d.source === 'desktop') meta = `桌面端 · ${QP.ago(d.sampledAt, now)}`;
    else if (slot.updatedAt) meta = QP.ago(slot.updatedAt, now);
    return `
      <div class="prov-head">
        <span class="dot" style="--c:${COLORS[name]}"></span>
        <span class="prov-name">${QP.NAMES[name]}</span>
        ${tag}
        <span class="prov-meta ${metaClass}">${esc(meta)}</span>
      </div>`;
  }

  function section(name, slot, now) {
    if (!slot || slot.status === 'off') return '';
    let body;
    if (slot.data) {
      if (name === 'codex') body = codexBody(slot.data, now);
      else if (name === 'claude') body = claudeBody(slot.data, now);
      else body = deepseekBody(slot.data, now);
      if (slot.status === 'error') body += note(`刷新失败：${slot.error}（显示的是 ${QP.ago(slot.updatedAt, now)}的数据）`, 'warn');
    } else if (slot.status === 'error') {
      body = `<div class="error"><span class="msg">${esc(slot.error)}</span><button class="link-btn" data-action="refresh">重试</button></div>`;
    } else {
      body = skeleton();
    }
    return `<section class="prov">${head(name, slot, now)}${body}</section>`;
  }

  function render() {
    if (!quota) return;
    const now = Date.now();
    list.innerHTML = ['codex', 'claude', 'deepseek'].map((n) => section(n, quota[n], now)).join('');
    if (!list.innerHTML.trim()) {
      list.innerHTML = '<section class="prov"><div class="empty"><span>三家都被关掉了</span><button class="link-btn" data-action="settings">去设置</button></div></section>';
    }
    refreshBtn.classList.toggle('spinning', Boolean(quota.refreshing));
    sub.textContent = quota.refreshing
      ? '正在刷新…'
      : quota.lastRefreshAt
        ? `更新于 ${QP.clock(quota.lastRefreshAt)}`
        : '正在读取…';
    footText.textContent = `每 ${config.refreshMinutes || 5} 分钟自动刷新`;
    renderTheme();
    requestAnimationFrame(fit);
  }

  function renderTheme() {
    const current = config.theme || 'system';
    for (const b of themeSeg.querySelectorAll('button')) {
      const on = b.dataset.theme === current;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
  }

  themeSeg.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-theme]');
    if (!b) return;
    config = (await api.saveSettings({ theme: b.dataset.theme })) || config;
    renderTheme();
  });

  function fit() {
    const rect = card.getBoundingClientRect();
    api.panelResize(Math.ceil(rect.height) + 40);
  }

  new ResizeObserver(fit).observe(card);

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'settings') api.openSettings();
    if (btn.dataset.action === 'refresh') api.refresh();
  });
  refreshBtn.addEventListener('click', () => api.refresh());
  $('btn-settings').addEventListener('click', () => api.openSettings());
  $('btn-close').addEventListener('click', () => api.panelClose());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') api.panelClose();
    if (e.key === 'F5' || (e.ctrlKey && e.key.toLowerCase() === 'r')) {
      e.preventDefault();
      api.refresh();
    }
  });

  function setAvatar(dataUrl) {
    avatar.style.backgroundImage = dataUrl ? `url("${dataUrl}")` : '';
  }

  api.onQuota((q) => {
    quota = q;
    render();
  });
  api.onConfig((c) => {
    config = c || config;
    render();
  });
  api.onPetIcon(setAvatar);
  setInterval(render, 30e3);

  (async () => {
    const st = await api.getState();
    quota = st.quota;
    config = st.config || {};
    setAvatar(st.petIcon);
    render();
  })();
})();

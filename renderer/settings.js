(() => {
  'use strict';

  const api = window.quotaPet;
  const QP = window.QP;
  const esc = QP.escapeHtml;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  let st = null;
  let toastTimer = 0;

  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1400);
  }

  async function save(patch) {
    st.config = await api.saveSettings(patch);
    fill();
    toast('已保存');
  }

  function renderKeyStatus(info) {
    const el = $('#ds-status');
    el.className = 'status';
    if (!info) {
      el.textContent = '未设置';
      return;
    }
    if (info.source === 'env') {
      el.textContent = `使用环境变量 DEEPSEEK_API_KEY（尾号 ${info.tail}）`;
    } else {
      el.textContent = `已保存${info.encrypted ? '（已加密）' : ''} · 尾号 ${info.tail}`;
    }
    el.classList.add('ok');
  }

  function setResult(text, tone) {
    const el = $('#ds-result');
    el.textContent = text;
    el.className = `result ${tone || ''}`;
  }

  function renderPets() {
    const box = $('#pets');
    if (!st.pets.length) {
      box.innerHTML = '';
      $('#pets-hint').textContent = '没有在 ~/.codex/pets 找到宠物，先用兜底的小圆球顶上。在 Codex 里创建自定义宠物后点“重新扫描”。';
      return;
    }
    const current = st.pet && st.pet.id;
    box.innerHTML = st.pets
      .map(
        (p) => `
        <button type="button" class="pet ${p.id === current ? 'on' : ''}" data-pet="${esc(p.id)}" title="${esc(p.description || p.displayName)}">
          <div class="preview" style="background-image:url('${esc(p.spriteUrl)}');background-size:${p.columns * 100}% ${p.rows * 100}%;background-position:0 0"></div>
          <span class="name">${esc(p.displayName)}</span>
          <span class="badge">${p.hasLookFrames ? '支持眼睛跟随' : '旧版精灵图'}</span>
        </button>`
      )
      .join('');
    $('#pets-hint').innerHTML =
      '宠物读取自 <code>~/.codex/pets</code>，和 Codex 里的自定义宠物是同一批。<button class="link" id="rescan" type="button">重新扫描</button>';
  }

  function fill() {
    const c = st.config;
    renderKeyStatus(c.deepseekKey);
    $('#lowBalance').value = c.lowBalance;
    $('#alertPercent').value = c.alertPercent;
    const sel = $('#refreshMinutes');
    if (![...sel.options].some((o) => Number(o.value) === c.refreshMinutes)) {
      sel.insertAdjacentHTML('beforeend', `<option value="${c.refreshMinutes}">${c.refreshMinutes} 分钟</option>`);
    }
    sel.value = String(c.refreshMinutes);
    for (const box of $$('[data-provider]')) box.checked = c.providers[box.dataset.provider] !== false;
    $('#eyeFollow').checked = Boolean(c.eyeFollow);
    $('#idleSelfPlay').checked = Boolean(c.idleSelfPlay);
    $('#autoStart').checked = Boolean(c.autoStart);
    if (document.activeElement !== $('#proxy')) $('#proxy').value = c.proxy || '';
    if (document.activeElement !== $('#codexPath')) $('#codexPath').value = c.codexPath || '';
    $('#codexPath').placeholder = st.codexDetected || '没有自动找到 codex，可以手动填写';
    for (const b of $$('#sizes button')) b.classList.toggle('on', Math.abs(Number(b.dataset.scale) - c.scale) < 0.001);
    for (const b of $$('#themes button')) {
      const on = b.dataset.theme === (c.theme || 'system');
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    renderPets();
  }

  // ---------- DeepSeek Key ----------

  async function saveKey() {
    const input = $('#ds-key');
    const btn = $('#ds-save');
    btn.disabled = true;
    setResult('正在验证…');
    try {
      const r = await api.setDeepseekKey(input.value);
      if (!r || !r.ok) {
        setResult((r && r.error) || '保存失败', 'err');
        return;
      }
      input.value = '';
      st.config = r.config;
      renderKeyStatus(r.config.deepseekKey);
      if (r.warning) setResult(r.warning, 'warn');
      else setResult(`验证通过，当前余额 ${r.balances.map((b) => QP.money(b.total, b.currency)).join(' / ') || '0'}`, 'ok');
    } finally {
      btn.disabled = false;
    }
  }

  $('#ds-save').addEventListener('click', saveKey);
  $('#ds-key').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveKey();
  });
  $('#ds-eye').addEventListener('click', () => {
    const input = $('#ds-key');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('#ds-eye').textContent = show ? '隐藏' : '显示';
  });
  $('#ds-clear').addEventListener('click', async () => {
    st.config = await api.clearDeepseekKey();
    renderKeyStatus(st.config.deepseekKey);
    setResult('已清除保存的 Key');
  });
  $('#ds-open').addEventListener('click', () => api.openExternal('https://platform.deepseek.com/api_keys'));

  // ---------- 其他设置 ----------

  $('#lowBalance').addEventListener('change', (e) => save({ lowBalance: Number(e.target.value) }));
  $('#alertPercent').addEventListener('change', (e) => save({ alertPercent: Number(e.target.value) }));
  $('#refreshMinutes').addEventListener('change', (e) => save({ refreshMinutes: Number(e.target.value) }));
  for (const box of $$('[data-provider]')) {
    box.addEventListener('change', () => save({ providers: { [box.dataset.provider]: box.checked } }));
  }
  $('#eyeFollow').addEventListener('change', (e) => save({ eyeFollow: e.target.checked }));
  $('#idleSelfPlay').addEventListener('change', (e) => save({ idleSelfPlay: e.target.checked }));
  $('#proxy').addEventListener('change', (e) => save({ proxy: e.target.value }));
  $('#codexPath').addEventListener('change', (e) => save({ codexPath: e.target.value }));
  $('#autoStart').addEventListener('change', async (e) => {
    const on = await api.setAutoStart(e.target.checked);
    e.target.checked = on;
    toast(on ? '已开启开机自启' : '已关闭开机自启');
  });
  $('#sizes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-scale]');
    if (b) save({ scale: Number(b.dataset.scale) });
  });
  $('#themes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-theme]');
    if (b) save({ theme: b.dataset.theme });
  });
  document.addEventListener('click', async (e) => {
    const petBtn = e.target.closest('[data-pet]');
    if (petBtn) {
      await save({ petId: petBtn.dataset.pet });
      st = await api.getState();
      fill();
    }
    if (e.target.closest('#rescan')) {
      st = await api.rescanPets();
      fill();
      toast(`找到 ${st.pets.length} 只宠物`);
    }
  });

  api.onConfig(async () => {
    st = await api.getState();
    fill();
  });

  (async () => {
    st = await api.getState();
    fill();
  })();
})();

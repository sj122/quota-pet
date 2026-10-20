'use strict';

const { EventEmitter } = require('events');

const PROVIDERS = ['codex', 'claude', 'deepseek'];

// 统一调度三家的刷新，保存每家最近一次成功的数据和错误；失败时保留旧数据。
class QuotaService extends EventEmitter {
  constructor({ runners, isEnabled }) {
    super();
    this.runners = runners;
    this.isEnabled = isEnabled;
    this.inflight = new Map();
    this.visibleRefreshes = 0;
    this.state = {};
    for (const name of PROVIDERS) {
      this.state[name] = { status: 'idle', data: null, error: null, updatedAt: null, errorAt: null };
    }
    this.lastRefreshAt = null;
  }

  snapshot() {
    const out = { refreshing: this.visibleRefreshes > 0, lastRefreshAt: this.lastRefreshAt };
    for (const name of PROVIDERS) {
      out[name] = this.isEnabled(name) ? { ...this.state[name] } : { status: 'off' };
    }
    return out;
  }

  emitUpdate() {
    this.emit('update', this.snapshot());
  }

  // silent=true 时不让宠物播放“忙碌”动画（比如 Claude 桌面端文件变化触发的静默刷新）
  async refresh(names = PROVIDERS, { silent = false } = {}) {
    const list = names.filter((n) => this.isEnabled(n));
    if (!list.length) {
      this.emitUpdate();
      return this.snapshot();
    }
    if (!silent) this.visibleRefreshes++;
    this.emitUpdate();
    try {
      await Promise.all(list.map((n) => this.refreshOne(n)));
    } finally {
      if (!silent) this.visibleRefreshes--;
      if (!silent) this.lastRefreshAt = Date.now();
      this.emitUpdate();
    }
    return this.snapshot();
  }

  refreshOne(name) {
    if (this.inflight.has(name)) return this.inflight.get(name);
    const slot = this.state[name];
    const job = (async () => {
      slot.status = 'loading';
      this.emitUpdate();
      try {
        slot.data = await this.runners[name]();
        slot.error = null;
        slot.status = 'ok';
        slot.updatedAt = Date.now();
      } catch (e) {
        slot.error = (e && e.message) || String(e);
        slot.errorAt = Date.now();
        slot.status = 'error';
      }
      this.emitUpdate();
    })().finally(() => this.inflight.delete(name));
    this.inflight.set(name, job);
    return job;
  }

  staleness() {
    let oldest = Infinity;
    for (const name of PROVIDERS) {
      if (!this.isEnabled(name)) continue;
      const t = this.state[name].updatedAt || 0;
      oldest = Math.min(oldest, t);
    }
    return oldest === Infinity ? 0 : Date.now() - oldest;
  }
}

module.exports = { QuotaService, PROVIDERS };

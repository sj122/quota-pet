'use strict';

const { safeStorage } = require('electron');
const { JsonFile } = require('./store');

const DEFAULTS = {
  petId: null,
  scale: 0.6,
  refreshMinutes: 5,
  position: null,
  providers: { codex: true, claude: true, deepseek: true },
  alertPercent: 10,
  lowBalance: 10,
  idleSelfPlay: true,
  eyeFollow: true,
  wander: true, // 闲着时沿任务栏走几步
  chatter: true, // 看场合说句话
  sleepWhenAway: true, // 离开电脑时睡觉，回来汇报
  throwable: true, // 甩出去会飞、在屏幕边缘弹
  petHidden: false,
  theme: 'system', // system | light | dark
  codexPath: '',
  proxy: '',
  deepseekKey: null,
};

function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && k !== 'deepseekKey') {
      out[k] = { ...base[k], ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

class Config {
  constructor(file) {
    this.store = new JsonFile(file, {});
    this.data = merge(DEFAULTS, this.store.read());
  }

  get() {
    return this.data;
  }

  set(patch) {
    this.data = merge(this.data, patch);
    this.store.write(this.data);
    return this.data;
  }

  // 环境变量优先；保存的 key 用 Windows DPAPI（safeStorage）加密后落盘。
  getDeepseekKey() {
    const env = (process.env.DEEPSEEK_API_KEY || '').trim();
    if (env) return env;
    const k = this.data.deepseekKey;
    if (!k) return null;
    try {
      if (k.enc) return safeStorage.decryptString(Buffer.from(k.enc, 'base64'));
      if (k.plain) return k.plain;
    } catch {}
    return null;
  }

  setDeepseekKey(key) {
    if (!key) {
      this.set({ deepseekKey: null });
      return;
    }
    const tail = key.slice(-4);
    const value = safeStorage.isEncryptionAvailable()
      ? { enc: safeStorage.encryptString(key).toString('base64'), tail }
      : { plain: key, tail };
    this.set({ deepseekKey: value });
  }

  deepseekKeyInfo() {
    const env = (process.env.DEEPSEEK_API_KEY || '').trim();
    if (env) return { source: 'env', tail: env.slice(-4), encrypted: false };
    const k = this.data.deepseekKey;
    if (!k) return null;
    return { source: 'saved', tail: k.tail || '', encrypted: Boolean(k.enc) };
  }

  publicView() {
    const { deepseekKey, ...rest } = this.data;
    return { ...rest, deepseekKey: this.deepseekKeyInfo() };
  }
}

module.exports = { Config, DEFAULTS };

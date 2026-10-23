'use strict';

// `electron . --demo`：用假数据跑一遍界面，方便看各种状态（额度告急、Claude 精确数据、DeepSeek 消费）。
module.exports = function demoRunners() {
  const H = 3600e3;
  const D = 86400e3;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daily = [0.82, 2.4, 0, 1.15, 3.62, 0.48, 1.37].map((v, i) => ({ t: today.getTime() - (6 - i) * D, v }));
  return {
    codex: async () => {
      const now = Date.now();
      return {
        source: 'app-server',
        plan: 'plus',
        windows: [
          { key: 'primary', usedPercent: 93, windowMins: 300, resetsAt: now + 47 * 60e3 },
          { key: 'secondary', usedPercent: 64, windowMins: 10080, resetsAt: now + 3.2 * D },
        ],
        extras: [],
        limitReached: null,
        resetCredits: { count: 2, expiries: [now + 5 * D, now + 13.5 * D] },
      };
    },
    claude: async () => {
      const now = Date.now();
      return {
        source: 'oauth',
        plan: 'max',
        windows: [
          { key: 'five_hour', windowMins: 300, model: null, usedPercent: 41.5, resetsAt: now + 2.3 * H },
          { key: 'seven_day', windowMins: 10080, model: null, usedPercent: 76, resetsAt: now + 4.6 * D },
          { key: 'seven_day_opus', windowMins: 10080, model: 'Opus', usedPercent: 12, resetsAt: now + 4.6 * D },
        ],
      };
    },
    deepseek: async () => ({
      available: true,
      balances: [{ currency: 'CNY', total: 86.42, granted: 6.42, toppedUp: 80 }],
      spend: {
        CNY: { today: 1.37, month: 23.58, monthTopups: 50, daily, since: Date.now() - 12 * D },
      },
    }),
  };
};

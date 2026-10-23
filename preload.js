'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('quotaPet', {
  // 通用
  getState: () => ipcRenderer.invoke('state:get'),
  refresh: () => ipcRenderer.invoke('quota:refresh'),
  openSettings: () => ipcRenderer.send('settings:open'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  onQuota: listen('quota:update'),
  onConfig: listen('config:changed'),
  onPetIcon: listen('pet:icon'),

  // 宠物窗口
  onPet: listen('pet:changed'),
  onCursor: listen('pet:cursor'),
  onInteractionReset: listen('pet:interaction-reset'),
  onProbe: listen('pet:probe'),
  interactionHeartbeat: () => ipcRenderer.send('pet:heartbeat'),
  onPanelVisible: listen('panel:visible'),
  onDebug: listen('pet:debug'),
  // 穿透由主进程决定：页面只上报当前帧的透明度图、气泡矩形和自己的命中判断。
  setHitMap: (map) => ipcRenderer.send('pet:hit-map', map),
  setHitBubble: (rect) => ipcRenderer.send('pet:hit-bubble', rect),
  setHit: (over) => ipcRenderer.send('pet:hit', Boolean(over)),
  cursorAck: (seq) => ipcRenderer.send('pet:cursor-ack', seq),
  probeAck: (token) => ipcRenderer.send('pet:probe-ack', token),
  dragStart: () => ipcRenderer.send('pet:drag-start'),
  dragMove: (dx, dy) => ipcRenderer.send('pet:drag-move', dx, dy),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  petClick: () => ipcRenderer.send('pet:click'),
  petMenu: () => ipcRenderer.send('pet:menu'),
  setPetIcon: (dataUrl) => ipcRenderer.send('pet:icon', dataUrl),

  // 额度面板
  panelResize: (height) => ipcRenderer.send('panel:resize', height),
  panelClose: () => ipcRenderer.send('panel:close'),

  // 设置
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  setAutoStart: (on) => ipcRenderer.invoke('settings:autostart', on),
  rescanPets: () => ipcRenderer.invoke('settings:rescan-pets'),
  setDeepseekKey: (key) => ipcRenderer.invoke('settings:deepseek-key', key),
  clearDeepseekKey: () => ipcRenderer.invoke('settings:deepseek-key-clear'),
});

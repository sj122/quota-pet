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
  interactionHeartbeat: () => ipcRenderer.send('pet:heartbeat'),
  onPanelVisible: listen('panel:visible'),
  onDebug: listen('pet:debug'),
  onMotion: listen('pet:motion'),
  onAway: listen('pet:away'),
  onEdge: listen('pet:edge'),
  setIgnoreMouse: (ignore) => ipcRenderer.send('pet:ignore-mouse', ignore),
  dragStart: () => ipcRenderer.send('pet:drag-start'),
  dragMove: (dx, dy) => ipcRenderer.send('pet:drag-move', dx, dy),
  // fling：松手时甩出去的速度 { vx, vy }（px/s），轻轻放下时为 null
  dragEnd: (fling) => ipcRenderer.send('pet:drag-end', fling || null),
  wander: () => ipcRenderer.send('pet:wander'),
  motionStop: () => ipcRenderer.send('pet:motion-stop'),
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

(() => {
  'use strict';
  if (window.parent === window) {
    window.petApi = window.quotaPet;
    return;
  }
  const listeners = new Map();
  const bridge = window.parent.petSurfaceApi;
  window.petApi = Object.fromEntries(bridge.methods.map((name) => [name,
    name.startsWith('on') ? (cb) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(cb);
      return () => listeners.get(name).delete(cb);
    } : (...args) => bridge.call(name, args),
  ]));
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || !event.data || !event.data.petEvent) return;
    for (const cb of listeners.get(event.data.petEvent) || []) cb(event.data.payload);
  });
})();

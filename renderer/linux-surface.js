(() => {
  'use strict';
  const api = window.quotaPet;
  const frame = document.getElementById('pet');
  const methods = Object.keys(api);
  window.petSurfaceApi = {
    methods,
    call: (name, args) => {
      if (!methods.includes(name) || name.startsWith('on')) throw new Error('Invalid pet API method');
      return api[name](...args);
    },
  };
  for (const name of methods.filter((name) => name.startsWith('on'))) {
    api[name]((payload) => frame.contentWindow.postMessage({ petEvent: name, payload }, '*'));
  }
  function place(bounds) {
    if (!bounds) return;
    frame.style.width = `${bounds.width}px`;
    frame.style.height = `${bounds.height}px`;
    frame.style.transform = `translate3d(${bounds.x}px, ${bounds.y}px, 0)`;
  }
  api.onSurface(place);
  api.getState().then((state) => {
    place(state.surface);
    frame.src = 'pet.html';
  });
})();

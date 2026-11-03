/* Viewport size is independent of the device and of the app's network address. */
(() => {
  const params = new URLSearchParams(location.search);
  const frame = document.getElementById('preview-frame');
  const status = document.getElementById('preview-status');
  let layout = params.get('layout') === 'desktop' ? 'desktop' : 'phone';
  let timer;
  const visible = outcome => window.harnessTrace?.('visible', { screen: `preview-${layout}`, outcome });
  function size() {
    const width = layout === 'phone' ? 390 : 1280, height = layout === 'phone' ? 844 : 900;
    const scale = Math.min(1, document.getElementById('preview-stage').clientWidth / width);
    Object.assign(frame.style, { width: `${width}px`, height: `${height}px`, transform: `scale(${scale})` });
    Object.assign(document.getElementById('preview-frame-box').style, { width: `${width * scale}px`, height: `${height * scale}px` });
    for (const mode of ['phone', 'desktop']) document.getElementById(`preview-${mode}`).setAttribute('aria-pressed', String(mode === layout));
  }
  for (const mode of ['phone', 'desktop']) document.getElementById(`preview-${mode}`).onclick = () => {
    layout = mode; params.set('layout', mode); history.replaceState(null, '', `${location.pathname}?${params}`);
    size(); visible('resized');
  };
  window.addEventListener('resize', size);
  size(); visible('loading');
  frame.onload = () => {
    if (!frame.hasAttribute('src')) return;
    clearTimeout(timer);
    status.textContent = 'Frame navigation finished. Verify the app is visible below; this does not confirm app success.';
    visible('frame-loaded');
  };
  async function open() {
    try {
      const node = params.get('node');
      const response = await fetch(`${node ? `/api/nodes/${encodeURIComponent(node)}` : ''}/api/apps`);
      if (!response.ok) throw Error('Could not load apps. Return to The DO and check the connection.');
      const app = (await response.json()).apps.find(a => a.id === params.get('app'));
      if (!app?.running || !app.reachable) throw Error('This app is stopped or still starting. Start it in The DO, then reload this preview.');
      const local = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname) && !node;
      const target = app.urls?.phone || (local && location.protocol === 'http:' ? app.urls?.desktop : null);
      if (!target) throw Error('This app needs a working Phone access address to preview from this device.');
      const url = new URL(target);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('App address is invalid.');
      document.getElementById('preview-name').textContent = app.name;
      const link = document.getElementById('preview-open'); link.href = url.href; link.hidden = false;
      status.textContent = 'Loading the app in the selected viewport…';
      frame.hidden = false; frame.src = url.href;
      timer = setTimeout(() => { status.textContent = 'The frame has not finished loading. Check the app directly if it stays blank.'; visible('timeout'); }, 15000);
    } catch (error) { status.textContent = error.message; visible('error'); }
  }
  open();
})();

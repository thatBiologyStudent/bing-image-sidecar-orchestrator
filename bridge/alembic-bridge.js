(() => {
  const PROTOCOL = 1;
  const VERSION = '1.0.1';

  let port = null;
  const pendingIds = new Set();
  let keepaliveTimer = null;

  function updateKeepalive() {
    if (pendingIds.size > 0 && !keepaliveTimer) {
      keepaliveTimer = setInterval(() => {
        if (port && pendingIds.size > 0) {
          try {
            port.postMessage({ type: 'PING' });
          } catch {
            // Port disconnect handler will clean up
          }
        }
      }, 20000);
    } else if (pendingIds.size === 0 && keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  }

  function failAllPending(code, error) {
    for (const id of pendingIds) {
      window.postMessage(
        { __bingSidecar: 'response', id, ok: false, error, code },
        window.location.origin
      );
    }
    pendingIds.clear();
    updateKeepalive();
  }

  function getPort() {
    if (port) return port;
    port = chrome.runtime.connect({ name: 'alembic-bridge' });

    port.onMessage.addListener((msg) => {
      if (!msg || !msg.id) return;
      if (msg.kind === 'event') {
        window.postMessage(
          { __bingSidecar: 'event', id: msg.id, event: msg.event, stage: msg.stage, detail: msg.detail },
          window.location.origin
        );
      } else if (msg.kind === 'response') {
        pendingIds.delete(msg.id);
        updateKeepalive();
        if (msg.ok) {
          window.postMessage(
            { __bingSidecar: 'response', id: msg.id, ok: true, result: msg.result },
            window.location.origin
          );
        } else {
          window.postMessage(
            { __bingSidecar: 'response', id: msg.id, ok: false, error: msg.error || 'Unknown error', code: msg.code || 'INTERNAL' },
            window.location.origin
          );
        }
      }
    });

    port.onDisconnect.addListener(() => {
      const errMsg = chrome.runtime.lastError?.message || 'Extension disconnected. Refresh this page.';
      const code = errMsg.includes('invalidated') ? 'EXTENSION_RELOADED' : 'DISCONNECTED';
      port = null;
      failAllPending(code, errMsg);
    });

    return port;
  }

  window.postMessage(
    { __bingSidecar: 'ready', protocol: PROTOCOL, version: VERSION },
    window.location.origin
  );

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.__bingSidecar !== 'request' || !data.id || !data.action) return;

    const { id, action, params } = data;
    try {
      const p = getPort();
      pendingIds.add(id);
      updateKeepalive();
      p.postMessage({ type: 'REQUEST', id, action, params: params || {} });
    } catch (err) {
      pendingIds.delete(id);
      updateKeepalive();
      window.postMessage(
        {
          __bingSidecar: 'response',
          id,
          ok: false,
          error: err?.message || 'Extension context invalidated. Refresh this page.',
          code: 'EXTENSION_RELOADED'
        },
        window.location.origin
      );
    }
  });
})();

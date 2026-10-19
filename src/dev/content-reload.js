// Dev builds only: reload LeetCode tabs after the extension reloads itself.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const timer = setInterval(async () => {
    try {
      const res = await api.runtime.sendMessage({ type: 'localleet:dev-check' });
      if (!res?.reload) return;
    } catch {
      // Extension context invalidated: the extension was reloaded.
    }
    clearInterval(timer);
    setTimeout(() => location.reload(), 800);
  }, 1000);
})();

const api = globalThis.browser ?? globalThis.chrome;
const DEFAULTS = { timeoutMs: 10000, preload: true };

const timeout = document.getElementById('timeout');
const preload = document.getElementById('preload');
const saved = document.getElementById('saved');

api.storage.local.get(DEFAULTS).then((s) => {
  timeout.value = Math.round(s.timeoutMs / 1000);
  preload.checked = s.preload;
});

async function save() {
  const seconds = Math.min(120, Math.max(1, Number(timeout.value) || DEFAULTS.timeoutMs / 1000));
  await api.storage.local.set({ timeoutMs: seconds * 1000, preload: preload.checked });
  saved.style.visibility = 'visible';
  setTimeout(() => (saved.style.visibility = 'hidden'), 1200);
}

timeout.addEventListener('change', save);
preload.addEventListener('change', save);

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

// Expected outputs saved by the content script (src/content/harvest.js).
const EXPECTED_PREFIX = 'expected:';
const clearExpected = document.getElementById('clear-expected');
const expectedCount = document.getElementById('expected-count');

async function expectedKeys() {
  return Object.keys(await api.storage.local.get(null)).filter((k) => k.startsWith(EXPECTED_PREFIX));
}

async function showExpectedCount() {
  const all = await api.storage.local.get(null);
  const stores = Object.entries(all).filter(([k]) => k.startsWith(EXPECTED_PREFIX));
  const cases = stores.reduce((n, [, v]) => n + Object.keys(v ?? {}).length, 0);
  expectedCount.textContent = `${cases} testcase${cases === 1 ? '' : 's'} across ${stores.length} problem${stores.length === 1 ? '' : 's'}`;
  clearExpected.disabled = cases === 0;
}

clearExpected.addEventListener('click', async () => {
  await api.storage.local.remove(await expectedKeys());
  showExpectedCount();
});
showExpectedCount();

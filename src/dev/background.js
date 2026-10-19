// Dev builds only: reload the extension when `npm run dev` rebuilds it.
// Content scripts ping us (keeping the service worker alive); we compare the
// build id on disk with the one we started with.
const api = globalThis.browser ?? globalThis.chrome;

const readBuildId = () =>
  fetch(api.runtime.getURL('dev/build-id.txt'), { cache: 'no-store' }).then((r) => r.text());
const startupId = readBuildId();

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'localleet:dev-check') return;
  Promise.all([startupId, readBuildId()]).then(([initial, now]) => {
    const reload = initial !== now;
    sendResponse({ reload });
    if (reload) setTimeout(() => api.runtime.reload(), 100);
  });
  return true;
});

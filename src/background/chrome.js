// Chrome only: MV3 service workers cannot spawn Web Workers, so the shared
// runner page (runner/runner.html) is hosted in an offscreen document.
// Firefox uses that same page directly as its background page instead.

const RUNNER_URL = 'runner/runner.html';
let creating = null;

async function ensureRunner() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(RUNNER_URL)],
  });
  if (existing.length) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: RUNNER_URL,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Runs WebAssembly language toolchains in Web Workers to execute LeetCode testcases locally.',
    })
    .finally(() => (creating = null));
  await creating;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'localleet:ensure-runner') return;
  ensureRunner().then(
    () => sendResponse({ ok: true }),
    (err) => sendResponse({ ok: false, error: String(err?.message || err) }),
  );
  return true;
});

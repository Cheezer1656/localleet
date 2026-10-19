// Content-script entry point: wires the LeetCode page, the results panel and
// the runner (which hosts the language toolchains) together.
(() => {
  const LL = globalThis.LocalLeet;
  const api = globalThis.browser ?? globalThis.chrome;
  const lc = LL.leetcode;

  const DEFAULT_SETTINGS = { timeoutMs: 10000, preload: true };
  let settings = { ...DEFAULT_SETTINGS };
  const settingsLoaded = api.storage.local
    .get(DEFAULT_SETTINGS)
    .then((s) => (settings = { ...DEFAULT_SETTINGS, ...s }))
    .catch(() => settings);
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [k, { newValue }] of Object.entries(changes)) {
      if (k in DEFAULT_SETTINGS) settings[k] = newValue;
    }
  });

  // ---- runner connection -----------------------------------------------------

  // The runner lives in an extension context outside the page (Chrome:
  // offscreen document, Firefox: background page). We ask the extension to
  // make sure it exists, then talk to it over a runtime Port.
  class RunnerClient {
    constructor(onMessage) {
      this.onMessage = onMessage;
      this.port = null;
      this.connecting = null;
    }

    connect() {
      if (this.port) return Promise.resolve(this.port);
      this.connecting ??= (async () => {
        try {
          const res = await api.runtime.sendMessage({ type: 'localleet:ensure-runner' });
          if (!res?.ok) throw new Error(res?.error || 'no response');
        } catch (err) {
          throw new Error(`Could not start the LocalLeet runner: ${err.message || err}`);
        } finally {
          this.connecting = null;
        }
        const port = api.runtime.connect({ name: 'localleet-runner' });
        port.onMessage.addListener((msg) => this.onMessage(msg));
        port.onDisconnect.addListener(() => {
          this.port = null;
          this.onMessage({ type: 'disconnected', reason: api.runtime.lastError?.message });
        });
        this.port = port;
        return port;
      })();
      return this.connecting;
    }

    async send(msg) {
      const port = await this.connect();
      port.postMessage(msg);
    }
  }

  // ---- run lifecycle ---------------------------------------------------------

  let runSeq = 0;
  let activeRun = null;

  const panel = new LL.Panel({
    onRun: () => run(),
    onCancel: () => cancel(),
    onAddCase: (lines) => addSavedCase(lines),
    onDismissCase: (lines) => {
      const slug = lc.currentSlug();
      if (slug) LL.harvest.dismiss(slug, lines);
    },
  });
  const tab = new LL.ResultsTab({ label: 'LocalLeet', content: panel.host, onMount: () => panel.setDocked(true) });
  panel.attachDock(tab);
  const runner = new RunnerClient(handleRunnerMessage);

  function verdictFor(result, expected, anyOrder) {
    if (result.status === 'ok') return LL.compare(result.output, expected, { anyOrder }) ?? 'ran';
    return result.status;
  }

  function handleRunnerMessage(msg) {
    switch (msg.type) {
      case 'status':
        panel.setRuntime(msg.state, msg.runtime, msg.error);
        break;
      case 'unsupported':
        panel.setRuntime('unsupported');
        if (activeRun && msg.id === activeRun.id) {
          endRun();
          panel.showError(
            `LocalLeet can't run "${msg.lang}" locally yet. Switch the editor to Python 3 ` +
              'or C++ (more languages are planned).',
          );
        }
        break;
      case 'queued':
        if (activeRun && msg.id === activeRun.id) {
          panel.setNotice('Waiting for a run in another LeetCode tab to finish…');
        }
        break;
      case 'case': {
        if (!activeRun || msg.id !== activeRun.id) return;
        const expected = activeRun.expected[msg.index];
        panel.caseResult(msg.index, msg.result, verdictFor(msg.result, expected, activeRun.anyOrder));
        break;
      }
      case 'done':
        if (!activeRun || msg.id !== activeRun.id) return;
        endRun();
        panel.finish(msg);
        break;
      case 'disconnected':
        panel.setRuntime('idle');
        if (activeRun) {
          endRun();
          panel.finish({
            internalError: `The runner was disconnected${msg.reason ? ` (${msg.reason})` : ''}. Try running again.`,
          });
        }
        break;
    }
  }

  function endRun() {
    activeRun = null;
    panel.setRunning(false);
  }

  function cancel() {
    if (!activeRun) return;
    runner.send({ type: 'cancel' }).catch(() => {});
  }

  async function run() {
    if (activeRun) return;
    panel.show();
    const slug = lc.currentSlug();
    if (!slug) {
      panel.showError('Open a LeetCode problem to run its testcases.');
      return;
    }
    const id = ++runSeq;
    activeRun = { id };
    panel.setRunning(true);
    try {
      const [state, problem] = await Promise.all([lc.requestEditorState(), lc.fetchProblem(slug)]);
      if (activeRun?.id !== id) return;
      if (!state.code) throw new Error('Could not read your code from the editor.');
      const lang = lc.leetcodeLang(state);
      const source = state.testcases?.trim() ? state.testcases : problem.exampleTestcases;
      const cases = lc.splitTestcases(source, problem.meta);
      if (!cases.length) throw new Error('There are no testcases to run.');
      // Expected outputs from the examples, else ones saved from LeetCode's own
      // Run and Submit results (harvest.js).
      const exampleMap = lc.expectedOutputs(problem);
      const savedMap = await LL.harvest.expectedOutputs(slug);
      if (activeRun?.id !== id) return;
      const found = cases.map((c) => {
        const key = lc.caseKey(c);
        if (exampleMap.has(key)) return { output: exampleMap.get(key), source: null };
        return savedMap.get(key) ?? null;
      });
      const expected = found.map((f) => f?.output ?? null);
      const sources = found.map((f) => f?.source ?? null);
      Object.assign(activeRun, { slug, expected, anyOrder: problem.anyOrder });
      lastRun = { slug, cases, anyOrder: problem.anyOrder };

      panel.startRun({ cases, paramNames: lc.paramNames(problem.meta), expected, sources });
      if (problem.meta.manual) {
        panel.setNotice(
          'LeetCode judges this problem with a custom checker; local output may be formatted differently.',
        );
      }
      await runner.send({
        type: 'run',
        id,
        lang,
        slug,
        code: state.code,
        meta: problem.meta,
        cases,
        timeoutMs: settings.timeoutMs,
      });
    } catch (err) {
      if (activeRun?.id !== id) return;
      endRun();
      panel.showError(err.message || String(err));
    }
  }

  // ---- outputs saved from LeetCode's Run and Submit -------------------------

  let lastRun = null; // { slug, cases, anyOrder } of the run on screen

  // A LeetCode Run of the same testcases can finish after the local run
  // started (or ended); fill in the expected outputs it revealed.
  async function fillSavedExpected(slug) {
    if (!lastRun || lastRun.slug !== slug) return;
    const run = lastRun;
    const saved = await LL.harvest.expectedOutputs(slug);
    if (lastRun !== run) return;
    run.cases.forEach((lines, i) => {
      const found = saved.get(lc.caseKey(lines));
      if (!found) return;
      if (activeRun?.slug === slug && activeRun.expected[i] == null) activeRun.expected[i] = found.output;
      panel.setExpected(i, found.output, found.source, (result) => verdictFor(result, found.output, run.anyOrder));
    });
  }

  let shownSlug = null;
  async function refreshFailedCases() {
    const slug = lc.currentSlug();
    shownSlug = slug;
    if (!slug) return panel.setFailedCases([], []);
    const [list, problem] = await Promise.all([LL.harvest.failedCases(slug), lc.fetchProblem(slug)]);
    if (shownSlug === slug) panel.setFailedCases(list, lc.paramNames(problem.meta));
  }

  async function addSavedCase(lines) {
    const slug = lc.currentSlug();
    if (!slug) return null;
    const problem = await lc.fetchProblem(slug);
    return lc.addTestcase(lines, problem.meta);
  }

  LL.harvest.onChange((slug) => {
    fillSavedExpected(slug).catch(() => {});
    if (slug === lc.currentSlug()) refreshFailedCases().catch(() => {});
  });

  // ---- page integration ------------------------------------------------------

  function injectButton() {
    if (document.getElementById('localleet-run-button')) return;
    const runButton = document.querySelector('[data-e2e-locator="console-run-button"]');
    const group = runButton?.closest('.group') ?? runButton?.parentElement;
    if (!group?.parentElement) return;

    const host = document.createElement('div');
    host.id = 'localleet-run-button';
    host.style.cssText = 'display:flex;align-items:center;flex:none;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        button {
          all: unset; box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px;
          height: 32px; padding: 0 10px; cursor: pointer; color: inherit; font: 500 14px/1 inherit;
          font-family: inherit; white-space: nowrap;
        }
        button:hover { background: rgba(128, 128, 128, 0.15); }
        button:focus-visible { outline: 2px solid #ffa116; outline-offset: -2px; }
        svg { width: 14px; height: 14px; color: #ffa116; }
      </style>
      <button type="button" title="Run testcases locally in your browser (Ctrl/⌘+Shift+')">
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 9.5v-6Zm4.75 1.2v3.6L9.9 6.5 6.75 4.7ZM1 12.5h14v1H1v-1Z"/>
        </svg>
        Local
      </button>`;
    shadow.querySelector('button').addEventListener('click', () => run());
    group.after(host);
  }

  function onKeyDown(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && !e.altKey && e.code === 'Quote') {
      e.preventDefault();
      e.stopPropagation();
      run();
    }
  }

  window.addEventListener('keydown', onKeyDown, true);

  // LeetCode is a single-page app that re-renders its toolbar on navigation.
  let injectQueued = false;
  new MutationObserver(() => {
    if (injectQueued) return;
    injectQueued = true;
    requestAnimationFrame(() => {
      injectQueued = false;
      injectButton();
      tab.ensure();
      if (lc.currentSlug() !== shownSlug) refreshFailedCases().catch(() => {});
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
  injectButton();
  tab.ensure();
  refreshFailedCases().catch(() => {});

  // Load the toolchain in the background so the first run is fast.
  async function warmUp() {
    await settingsLoaded;
    if (!settings.preload || !lc.currentSlug()) return;
    let lang = null;
    try {
      lang = lc.leetcodeLang(await lc.requestEditorState());
    } catch {
      lang = lc.leetcodeLang(null);
    }
    if (lang) runner.send({ type: 'warmup', lang }).catch(() => {});
  }
  const idle = globalThis.requestIdleCallback ?? ((fn) => setTimeout(fn, 1500));
  idle(() => warmUp(), { timeout: 5000 });
})();

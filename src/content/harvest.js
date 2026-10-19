// Saves the expected outputs LeetCode reveals through its own Run and Submit
// (page-bridge.js forwards them), so later local runs of the same inputs get a
// verdict. A Run gives LeetCode's expected output for every testcase it ran; a
// failed Submit gives the failing hidden testcase and its expected output.
//
// Stored in storage.local under `expected:<slug>` as
//   { [caseKey]: { lines, output, source: 'run' | 'submit', submission?, at } }
// where `submission` is the status of the failed submission that revealed it.
(() => {
  const LL = (globalThis.LocalLeet ??= {});
  const api = globalThis.browser ?? globalThis.chrome;
  const lc = LL.leetcode;

  const PREFIX = 'expected:';
  const MAX_PER_PROBLEM = 500;
  const listeners = new Set();

  async function load(slug) {
    const key = PREFIX + slug;
    try {
      return (await api.storage.local.get(key))[key] ?? {};
    } catch {
      return {};
    }
  }

  // Writes are serialized so that a Run and a Submit finishing together
  // don't overwrite each other.
  let writes = Promise.resolve();
  function save(slug, entries) {
    if (!entries.length) return writes;
    writes = writes
      .then(async () => {
        const store = await load(slug);
        const at = Date.now();
        for (const { lines, output, source, submission } of entries) {
          const key = lc.caseKey(lines);
          const old = store[key];
          store[key] = { lines, output, source, at };
          // Keep a case listed as a failed submission once it has been one.
          const status = submission ?? old?.submission;
          if (status) store[key].submission = status;
        }
        const keys = Object.keys(store);
        if (keys.length > MAX_PER_PROBLEM) {
          keys
            .sort((a, b) => store[a].at - store[b].at)
            .slice(0, keys.length - MAX_PER_PROBLEM)
            .forEach((k) => delete store[k]);
        }
        await api.storage.local.set({ [PREFIX + slug]: store });
      })
      .catch(() => {});
    return writes;
  }

  const isOutput = (v) => typeof v === 'string' && v.trim() !== '';

  async function onHarvest(event) {
    const { slug } = event;
    if (typeof slug !== 'string' || !slug) return;
    const problem = await lc.fetchProblem(slug);
    if (event.kind === 'run') {
      if (!event.expectedOk || !Array.isArray(event.expected) || typeof event.dataInput !== 'string') return;
      const cases = lc.splitTestcases(event.dataInput, problem.meta);
      // LeetCode pads the answers with empty strings, so only trust a full set.
      if (event.expected.length < cases.length) return;
      const entries = cases
        .map((lines, i) => ({ lines, output: event.expected[i], source: 'run' }))
        .filter((e) => isOutput(e.output));
      await save(slug, entries);
    } else if (event.kind === 'submit') {
      if (typeof event.input !== 'string' || !isOutput(event.expected)) return;
      const cases = lc.splitTestcases(event.input, problem.meta);
      if (cases.length !== 1) return;
      await save(slug, [
        { lines: cases[0], output: event.expected, source: 'submit', submission: event.statusMsg || 'Failed' },
      ]);
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || typeof event.data !== 'string') return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg?.type === 'localleet:harvest') onHarvest(msg).catch(() => {});
  });
  // The bridge holds anything it saw before this script loaded until now.
  window.postMessage(JSON.stringify({ type: 'localleet:harvest-ready' }), location.origin);

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const key of Object.keys(changes)) {
      if (key.startsWith(PREFIX)) listeners.forEach((fn) => fn(key.slice(PREFIX.length)));
    }
  });

  // Map of caseKey -> { output, source } for a problem.
  async function expectedOutputs(slug) {
    const store = await load(slug);
    return new Map(Object.entries(store).map(([k, v]) => [k, { output: v.output, source: v.source }]));
  }

  // Testcases from failed submissions, newest first.
  async function failedCases(slug) {
    const store = await load(slug);
    return Object.values(store)
      .filter((v) => v.submission)
      .sort((a, b) => b.at - a.at);
  }

  // Removes a case from the failed-submission list; its expected output stays.
  async function dismiss(slug, lines) {
    writes = writes
      .then(async () => {
        const store = await load(slug);
        const entry = store[lc.caseKey(lines)];
        if (!entry) return;
        delete entry.submission;
        await api.storage.local.set({ [PREFIX + slug]: store });
      })
      .catch(() => {});
    return writes;
  }

  LL.harvest = {
    expectedOutputs,
    failedCases,
    dismiss,
    // Calls `fn(slug)` whenever a problem's saved outputs change (in any tab).
    onChange: (fn) => listeners.add(fn),
  };
})();

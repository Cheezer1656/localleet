// Runs in the page's MAIN world so it can reach LeetCode's editor objects
// (Monaco for code, CodeMirror for the testcase "Source" view), which the
// isolated content script cannot see. Replies to requests over postMessage;
// payloads are JSON strings to avoid cross-world object wrappers in Firefox.
//
// It also watches LeetCode's own Run and Submit requests and forwards the
// expected outputs they reveal to the content script (see harvest.js).
(() => {
  const REQUEST = 'localleet:request';
  const RESPONSE = 'localleet:response';
  const HARVEST = 'localleet:harvest';
  const HARVEST_READY = 'localleet:harvest-ready';

  function editorState() {
    const state = { code: null, lang: null, testcases: null };
    const monaco = window.monaco;
    if (monaco?.editor) {
      const editors = monaco.editor.getEditors?.() ?? [];
      const models = editors.length
        ? editors.map((e) => e.getModel()).filter(Boolean)
        : monaco.editor.getModels();
      const model = models.find((m) => m.getLanguageId() !== 'plaintext') ?? models[0];
      if (model) {
        state.code = model.getValue();
        state.lang = model.getLanguageId();
      }
    }
    // The testcase editor's "Source" view is a CodeMirror 6 instance that is
    // kept in sync with the per-case tabs, even while hidden.
    const cm = document.querySelector('.cm-content');
    const view = cm?.cmView?.view;
    if (view?.state?.doc) {
      state.testcases = view.state.doc.toString();
    } else if (cm) {
      state.testcases = cm.innerText;
    }
    return state;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Appends a testcase the way a user would: "+" (which copies the selected
  // case), then typing each input. Editing the Source view directly doesn't
  // work, since LeetCode overwrites it from the per-case state.
  async function appendTestcase(lines) {
    const tags = () => [...document.querySelectorAll('[data-e2e-locator="console-testcase-tag"]')];
    const before = tags();
    const plus = before.at(-1)?.parentElement?.querySelector(':scope > button:not([data-e2e-locator])');
    if (!plus) throw new Error('Open LeetCode’s Testcase tab (the per-case view, not Source) and try again.');
    if (plus.disabled) throw new Error('LeetCode won’t take more testcases; remove one first.');
    plus.click();
    for (let i = 0; i < 20 && tags().length <= before.length; i++) await sleep(50);
    if (tags().length <= before.length) throw new Error('LeetCode didn’t add a testcase.');
    tags().at(-1).click();
    await sleep(50);
    const inputs = [...document.querySelectorAll('[data-e2e-locator="console-testcase-input"]')];
    if (inputs.length !== lines.length) {
      throw new Error(`Expected ${lines.length} testcase inputs on the page but found ${inputs.length}.`);
    }
    // One input at a time: LeetCode drops an update made before it re-renders.
    for (const [i, input] of inputs.entries()) {
      input.focus();
      input.textContent = lines[i];
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      await sleep(100);
    }
    document.activeElement?.blur();
    await sleep(50);
    return editorState();
  }

  // ---- LeetCode's Run and Submit ---------------------------------------------

  // Run: POST /problems/<slug>/interpret_solution/ {data_input} -> {interpret_id}
  // Submit: POST /problems/<slug>/submit/ -> {submission_id}
  // Both are then polled at /submissions/detail/<id>/check/ until SUCCESS.
  const pending = new Map(); // interpret or submission id -> { kind, slug, dataInput }
  let harvestQueue = []; // events from before the content script was listening

  function emit(event) {
    if (harvestQueue) harvestQueue.push(event);
    else window.postMessage(JSON.stringify({ type: HARVEST, ...event }), location.origin);
  }

  // Returns a handler for the request if it's one we watch. Handlers take
  // promises of the request body (a string or null) and the parsed response.
  function watcherFor(url) {
    let path;
    try {
      path = new URL(url, location.href).pathname;
    } catch {
      return null;
    }
    let m;
    if ((m = path.match(/^\/problems\/([^/]+)\/interpret_solution\/?$/))) {
      const slug = m[1];
      return async (body, json) => {
        const [text, data] = await Promise.all([body, json]);
        if (data?.interpret_id == null) return;
        let dataInput = null;
        try {
          dataInput = JSON.parse(text)?.data_input ?? null;
        } catch {}
        pending.set(String(data.interpret_id), { kind: 'run', slug, dataInput });
      };
    }
    if ((m = path.match(/^\/problems\/([^/]+)\/submit\/?$/))) {
      const slug = m[1];
      return async (_body, json) => {
        const data = await json;
        if (data?.submission_id != null) pending.set(String(data.submission_id), { kind: 'submit', slug });
      };
    }
    if ((m = path.match(/^\/submissions\/detail\/([^/]+)\/check\/?$/))) {
      const id = m[1];
      return async (_body, json) => {
        const data = await json;
        const job = pending.get(id);
        if (!job || data?.state !== 'SUCCESS') return;
        pending.delete(id);
        if (job.kind === 'run') {
          emit({
            kind: 'run',
            slug: job.slug,
            dataInput: job.dataInput,
            expected: data.expected_code_answer ?? null,
            expectedOk: data.expected_run_success !== false,
          });
        } else {
          emit({
            kind: 'submit',
            slug: job.slug,
            statusMsg: data.status_msg ?? null,
            input: data.last_testcase ?? null,
            expected: data.expected_output ?? null,
          });
        }
      };
    }
    return null;
  }

  function watch(handler, body, json) {
    handler(body, json).catch(() => {});
  }

  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    let handler = null;
    let body = null;
    try {
      const isRequest = input instanceof Request;
      handler = watcherFor(isRequest ? input.url : String(input));
      if (handler) {
        // A Request's body is consumed by the fetch, so read a clone first.
        if (typeof init?.body === 'string') body = Promise.resolve(init.body);
        else if (isRequest && !init?.body) body = input.clone().text();
        else body = Promise.resolve(null);
      }
    } catch {
      handler = null;
    }
    const promise = nativeFetch.apply(this, arguments);
    if (handler) watch(handler, body, promise.then((res) => res.clone().json()));
    return promise;
  };

  if (typeof XMLHttpRequest !== 'undefined') {
    const xhrUrls = new WeakMap();
    const { open, send } = XMLHttpRequest.prototype;
    XMLHttpRequest.prototype.open = function (_method, url) {
      xhrUrls.set(this, String(url));
      return open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      const handler = xhrUrls.has(this) ? watcherFor(xhrUrls.get(this)) : null;
      if (handler) {
        const json = new Promise((resolve, reject) => {
          this.addEventListener('load', () => {
            try {
              resolve(this.responseType === 'json' ? this.response : JSON.parse(this.responseText));
            } catch (err) {
              reject(err);
            }
          });
          this.addEventListener('error', reject);
        });
        watch(handler, Promise.resolve(typeof body === 'string' ? body : null), json);
      }
      return send.apply(this, arguments);
    };
  }

  // ---- messages from the content script --------------------------------------

  window.addEventListener('message', (event) => {
    if (event.source !== window || typeof event.data !== 'string') return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg?.type === HARVEST_READY) {
      const queued = harvestQueue ?? [];
      harvestQueue = null;
      queued.forEach(emit);
      return;
    }
    if (msg?.type !== REQUEST) return;
    (async () => {
      if (msg.op === 'add-testcase') return appendTestcase(msg.lines.map(String));
      return editorState();
    })().then(
      (state) => ({ ok: true, state }),
      (err) => ({ ok: false, error: err?.message ?? String(err) }),
    ).then((payload) => {
      window.postMessage(JSON.stringify({ type: RESPONSE, id: msg.id, ...payload }), location.origin);
    });
  });
})();

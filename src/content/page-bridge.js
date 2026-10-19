// Runs in the page's MAIN world so it can reach LeetCode's editor objects
// (Monaco for code, CodeMirror for the testcase "Source" view), which the
// isolated content script cannot see. Replies to requests over postMessage;
// payloads are JSON strings to avoid cross-world object wrappers in Firefox.
(() => {
  const REQUEST = 'localleet:request';
  const RESPONSE = 'localleet:response';

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

  window.addEventListener('message', (event) => {
    if (event.source !== window || typeof event.data !== 'string') return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg?.type !== REQUEST) return;
    let payload;
    try {
      payload = { ok: true, state: editorState() };
    } catch (err) {
      payload = { ok: false, error: String(err) };
    }
    window.postMessage(JSON.stringify({ type: RESPONSE, id: msg.id, ...payload }), location.origin);
  });
})();

// LeetCode page integration: problem metadata, example outputs, editor state.
(() => {
  const LL = (globalThis.LocalLeet ??= {});

  const QUERY = `query localleetQuestion($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
      questionId
      questionFrontendId
      title
      titleSlug
      content
      metaData
      exampleTestcases
      sampleTestCase
    }
  }`;

  const problemCache = new Map();

  // Firefox content-script fetches carry the extension's principal; use the
  // page's own fetch there so the request looks like LeetCode's own.
  function pageFetch(url, init) {
    if (typeof cloneInto === 'function' && typeof content !== 'undefined' && content?.fetch) {
      return content.fetch(url, cloneInto(init, content));
    }
    return fetch(url, init);
  }

  function currentSlug() {
    const m = location.pathname.match(/^\/problems\/([^/]+)/);
    return m ? m[1] : null;
  }

  async function fetchProblem(slug) {
    if (problemCache.has(slug)) return problemCache.get(slug);
    const promise = (async () => {
      const res = await pageFetch('/graphql', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: QUERY, variables: { titleSlug: slug } }),
      });
      if (!res.ok) throw new Error(`LeetCode API returned ${res.status}`);
      const q = (await res.json())?.data?.question;
      if (!q) throw new Error(`Problem "${slug}" not found`);
      const meta = JSON.parse(q.metaData);
      const content = q.content ?? '';
      return {
        slug,
        id: q.questionFrontendId,
        title: q.title,
        meta,
        exampleTestcases: q.exampleTestcases || q.sampleTestCase || '',
        exampleOutputs: parseExampleOutputs(content),
        anyOrder: /in any order/i.test(content.replace(/<[^>]+>/g, '')),
      };
    })();
    problemCache.set(slug, promise);
    promise.catch(() => problemCache.delete(slug));
    return promise;
  }

  // Pull the "Output:" value of each example out of the problem statement.
  // Handles both the old <pre> layout and the newer example-block layout.
  function parseExampleOutputs(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const outputs = [];
    for (const label of doc.querySelectorAll('strong, b')) {
      if (!/^\s*(Output|输出)\s*[:：]?\s*$/i.test(label.textContent)) continue;
      let text = '';
      for (let n = label.nextSibling; n; n = n.nextSibling) {
        if (n.nodeType === Node.ELEMENT_NODE && /^(STRONG|B|BR|P|DIV|PRE)$/.test(n.nodeName)) break;
        text += n.textContent;
      }
      const line = text.split('\n').map((s) => s.trim()).find(Boolean);
      outputs.push(line ?? '');
    }
    return outputs;
  }

  function linesPerCase(meta) {
    if (meta.systemdesign) return 2;
    return Math.max(1, (meta.params ?? []).length);
  }

  function splitTestcases(text, meta) {
    const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length);
    const n = linesPerCase(meta);
    if (lines.length % n !== 0) {
      throw new Error(
        `Testcases have ${lines.length} lines, but each case needs ${n} ` +
          `(${paramNames(meta).join(', ')}).`,
      );
    }
    const cases = [];
    for (let i = 0; i < lines.length; i += n) cases.push(lines.slice(i, i + n));
    return cases;
  }

  function paramNames(meta) {
    if (meta.systemdesign) return ['methods', 'arguments'];
    return (meta.params ?? []).map((p) => p.name);
  }

  const caseKey = (lines) => lines.join('\n').replace(/\s+/g, '');

  // Map each known example input to its expected output from the statement.
  function expectedOutputs(problem) {
    const map = new Map();
    let examples;
    try {
      examples = splitTestcases(problem.exampleTestcases, problem.meta);
    } catch {
      return map;
    }
    examples.forEach((lines, i) => {
      const out = problem.exampleOutputs[i];
      if (out) map.set(caseKey(lines), out);
    });
    return map;
  }

  let requestSeq = 0;
  function requestEditorState(timeoutMs = 1500) {
    const id = `${Date.now()}-${++requestSeq}`;
    return new Promise((resolve, reject) => {
      const onMessage = (event) => {
        if (event.source !== window || typeof event.data !== 'string') return;
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg?.type !== 'localleet:response' || msg.id !== id) return;
        cleanup();
        msg.ok ? resolve(msg.state) : reject(new Error(msg.error));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Could not read the LeetCode editor (page bridge did not answer).'));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
      };
      window.addEventListener('message', onMessage);
      window.postMessage(JSON.stringify({ type: 'localleet:request', id }), location.origin);
    });
  }

  // Monaco language ids on LeetCode match LeetCode's language slugs for most
  // languages; fall back to the language LeetCode remembers in localStorage.
  function leetcodeLang(state) {
    if (state?.lang && state.lang !== 'plaintext') return state.lang;
    try {
      return JSON.parse(localStorage.getItem('global_lang')) ?? null;
    } catch {
      return localStorage.getItem('global_lang');
    }
  }

  LL.leetcode = {
    currentSlug,
    fetchProblem,
    parseExampleOutputs,
    splitTestcases,
    paramNames,
    caseKey,
    expectedOutputs,
    requestEditorState,
    leetcodeLang,
  };
})();

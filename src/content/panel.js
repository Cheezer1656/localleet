// Results view, rendered in a shadow root to stay isolated from LeetCode's
// styles. It is docked into a LeetCode tab when one is available (see tab.js)
// and falls back to a floating window otherwise.
(() => {
  const LL = (globalThis.LocalLeet ??= {});
  const api = globalThis.browser ?? globalThis.chrome;

  const VERDICT_LABEL = {
    match: 'Matches expected',
    'match-any-order': 'Matches expected (any order)',
    mismatch: 'Differs from expected',
    ran: 'Ran',
    runtime_error: 'Runtime Error',
    harness_error: 'Invalid Testcase',
    timeout: 'Time Limit Exceeded',
    skipped: 'Not run',
    pending: 'Running…',
  };

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : String(c));
    }
    return node;
  }

  class Panel {
    constructor({ onRun, onCancel }) {
      this.onRun = onRun;
      this.onCancel = onCancel;
      this.state = { phase: 'idle', cases: [], selected: 0, runtime: null, runtimeState: 'idle', diff: true };
      this.expanded = new Set(); // `${case}:${field}` keys of values shown in full
      this.overflow = new ResizeObserver((entries) => {
        for (const { target } of entries) {
          target.parentElement?.classList.toggle('overflows', target.scrollHeight > COLLAPSED_HEIGHT);
        }
      });

      this.host = el('div', { id: 'localleet-panel-host' });
      this.root = this.host.attachShadow({ mode: 'open' });
      const style = el('link', { rel: 'stylesheet', href: api.runtime.getURL('content/panel.css') });
      this.panel = el('div', { class: 'panel', hidden: true });
      this.root.append(style, this.panel);
      this.buildChrome();
      this.syncTheme();
      new MutationObserver(() => this.syncTheme()).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'data-theme', 'style'],
      });
      this.dock = null;
    }

    // `dock` is a ResultsTab; while it is available the panel lives in it.
    attachDock(dock) {
      this.dock = dock;
    }

    setDocked(docked) {
      this.panel.classList.toggle('docked', docked);
      this.host.style.cssText = docked ? 'display:block;width:100%;height:100%;' : '';
      if (docked) {
        this.panel.hidden = false;
        this.panel.style.fontFamily = getComputedStyle(document.body).fontFamily;
      } else {
        this.panel.style.fontFamily = '';
      }
    }

    syncTheme() {
      const html = document.documentElement;
      const dark = html.classList.contains('dark') || html.dataset.theme === 'dark';
      this.panel.dataset.theme = dark ? 'dark' : 'light';
    }

    buildChrome() {
      this.runtimeLabel = el('span', { class: 'runtime' });
      this.runButton = el(
        'button',
        {
          class: 'run',
          title: 'Run testcases locally (Ctrl/⌘+Shift+\')',
          onclick: () => (this.running ? this.onCancel() : this.onRun()),
        },
        'Run locally',
      );
      const header = el(
        'header',
        { class: 'bar' },
        el('span', { class: 'logo' }, 'LocalLeet'),
        this.runtimeLabel,
        el('span', { class: 'spacer' }),
        this.runButton,
        el('button', { class: 'icon floating-only', title: 'Collapse', onclick: () => this.toggleCollapsed() }, '▾'),
        el('button', { class: 'icon floating-only', title: 'Close', onclick: () => this.hide() }, '✕'),
      );
      this.body = el('div', { class: 'body' });
      this.panel.append(header, this.body);
      this.enableDrag(header);
      this.renderRuntime();
      this.renderBody();
    }

    enableDrag(handle) {
      handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button') || this.panel.classList.contains('docked')) return;
        const rect = this.panel.getBoundingClientRect();
        const dx = e.clientX - rect.left;
        const dy = e.clientY - rect.top;
        handle.setPointerCapture(e.pointerId);
        const move = (ev) => {
          const x = Math.min(Math.max(0, ev.clientX - dx), window.innerWidth - 120);
          const y = Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - 40);
          Object.assign(this.panel.style, { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto' });
        };
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
      });
    }

    show() {
      if (this.dock?.activate()) return;
      this.setDocked(false);
      if (this.host.parentElement !== document.documentElement) document.documentElement.append(this.host);
      this.panel.hidden = false;
    }

    hide() {
      if (this.panel.classList.contains('docked')) this.dock?.deactivate();
      else this.panel.hidden = true;
    }

    toggleCollapsed() {
      this.panel.classList.toggle('collapsed');
    }

    setRuntime(runtimeState, runtime, error) {
      Object.assign(this.state, { runtimeState, runtime: runtime ?? this.state.runtime, runtimeError: error });
      this.renderRuntime();
    }

    renderRuntime() {
      const { runtimeState, runtime, runtimeError } = this.state;
      const text = {
        idle: 'idle',
        loading: 'loading toolchain…',
        ready: runtime ?? 'ready',
        error: 'toolchain failed to load',
        unsupported: 'language not supported',
      }[runtimeState];
      this.runtimeLabel.replaceChildren(el('span', { class: `dot ${runtimeState}` }), text);
      this.runtimeLabel.title = runtimeError ?? '';
    }

    setRunning(running) {
      this.running = running;
      this.runButton.textContent = running ? 'Cancel' : 'Run locally';
      this.runButton.classList.toggle('cancel', running);
    }

    // ---- run lifecycle ------------------------------------------------------

    startRun({ cases, paramNames, expected }) {
      this.state.phase = 'running';
      this.state.error = null;
      this.state.compileError = null;
      this.state.notice = null;
      this.state.cases = cases.map((lines, i) => ({
        lines,
        expected: expected[i] ?? null,
        result: null,
        verdict: 'pending',
      }));
      this.state.paramNames = paramNames;
      this.expanded.clear();
      if (this.state.selected >= cases.length) this.state.selected = 0;
      this.show();
      this.panel.classList.remove('collapsed');
      this.renderBody();
    }

    caseResult(index, result, verdict) {
      const c = this.state.cases[index];
      if (!c) return;
      c.result = result;
      c.verdict = verdict;
      this.renderBody();
    }

    finish({ compileError, internalError, cancelled }) {
      this.state.phase = 'done';
      this.state.compileError = compileError ?? null;
      for (const c of this.state.cases) if (c.verdict === 'pending') c.verdict = 'skipped';
      if (internalError) this.state.error = internalError;
      if (cancelled) this.state.notice = 'Run cancelled.';
      this.renderBody();
    }

    showError(message) {
      this.state.phase = 'error';
      this.state.error = message;
      this.show();
      this.panel.classList.remove('collapsed');
      this.renderBody();
    }

    setNotice(message) {
      this.state.notice = message;
      this.renderBody();
    }

    // ---- rendering ----------------------------------------------------------

    summary() {
      const { phase, cases, compileError } = this.state;
      if (phase === 'running') {
        const done = cases.filter((c) => c.verdict !== 'pending').length;
        return { cls: 'running', title: `Running… ${done}/${cases.length}` };
      }
      if (compileError) return { cls: 'bad', title: 'Compile Error' };
      const verdicts = cases.map((c) => c.verdict);
      const time = cases.reduce((t, c) => t + (c.result?.timeMs ?? 0), 0);
      const sub = `Runtime: ${formatMs(time)}`;
      if (verdicts.includes('timeout')) return { cls: 'bad', title: 'Time Limit Exceeded', sub };
      if (verdicts.includes('runtime_error')) return { cls: 'bad', title: 'Runtime Error', sub };
      if (verdicts.includes('harness_error')) return { cls: 'bad', title: 'Invalid Testcase', sub };
      if (verdicts.includes('mismatch')) return { cls: 'bad', title: 'Wrong Answer', sub };
      if (verdicts.length && verdicts.every((v) => v.startsWith('match'))) {
        return { cls: 'good', title: 'Accepted', sub };
      }
      return { cls: 'neutral', title: 'Finished', sub };
    }

    renderBody() {
      this.overflow.disconnect();
      const { phase, cases, error, notice, compileError } = this.state;
      const parts = [];
      if (phase === 'idle') {
        parts.push(
          el(
            'p',
            { class: 'hint' },
            'Runs the testcases from LeetCode’s Testcase panel in your browser. ',
            'Expected outputs come from the problem’s examples.',
          ),
        );
      }
      if (error) parts.push(el('pre', { class: 'error-box' }, error));
      if (notice) parts.push(el('p', { class: 'notice' }, notice));
      if (phase === 'running' || phase === 'done') {
        const s = this.summary();
        const canDiff = cases.some((c) => c.verdict === 'mismatch' && c.expected != null);
        parts.push(
          el(
            'div',
            { class: `summary ${s.cls}` },
            el('strong', {}, s.title),
            s.sub && el('span', {}, s.sub),
            canDiff && this.renderDiffToggle(),
          ),
        );
        if (compileError) parts.push(el('pre', { class: 'error-box' }, compileError));
        if (cases.length && !compileError) {
          parts.push(this.renderTabs(), this.renderCase(cases[this.state.selected]));
        }
      }
      this.body.replaceChildren(...parts);
    }

    renderTabs() {
      return el(
        'div',
        { class: 'tabs', role: 'tablist' },
        this.state.cases.map((c, i) =>
          el(
            'button',
            {
              class: `tab ${i === this.state.selected ? 'active' : ''}`,
              role: 'tab',
              title: [VERDICT_LABEL[c.verdict], c.result?.timeMs != null && formatMs(c.result.timeMs)]
                .filter(Boolean)
                .join(' · '),
              onclick: () => {
                this.state.selected = i;
                this.renderBody();
              },
            },
            caseIcon(c.verdict),
            `Case ${i + 1}`,
          ),
        ),
      );
    }

    renderDiffToggle() {
      const on = this.state.diff;
      const button = el('button', {
        class: `diff-toggle ${on ? 'on' : ''}`,
        title: on ? 'Hide differences' : 'Highlight differences',
        'aria-pressed': String(on),
        onclick: () => {
          this.state.diff = !this.state.diff;
          this.renderBody();
        },
      });
      button.append(svgIcon('0 0 16 16', ICON_DIFF));
      return button;
    }

    renderCase(c) {
      const names = this.state.paramNames ?? [];
      const r = c.result;
      // Mirrors LeetCode's Test Result layout: a label above one or more boxes.
      const box = (key, value, boxLabel) =>
        el('div', { class: 'box' }, boxLabel && el('div', { class: 'box-label' }, boxLabel), this.renderValue(key, value));
      const section = (label, ...boxes) =>
        el('div', { class: 'section' }, el('div', { class: 'label' }, label), el('div', { class: 'boxes' }, boxes));
      const at = `${this.state.selected}:`;
      const out = [];
      if (r?.error) out.push(el('pre', { class: 'error-box' }, r.error));
      out.push(
        section('Input', ...c.lines.map((line, i) => box(`${at}in${i}`, line, `${names[i] ?? `arg${i + 1}`} =`))),
      );
      if (r?.stdout) out.push(section('Stdout', box(`${at}stdout`, r.stdout)));
      const diff =
        this.state.diff && c.verdict === 'mismatch' && r?.output != null && c.expected != null
          ? highlightDiff(r.output, c.expected)
          : null;
      if (r && r.output != null) out.push(section('Output', box(`${at}output`, diff?.actual ?? r.output)));
      if (c.expected != null) out.push(section('Expected', box(`${at}expected`, diff?.expected ?? c.expected)));
      return el('div', { class: 'case' }, out);
    }

    // A value that LeetCode-style collapses to a few lines with "View more".
    // Whether it overflows is only known once laid out (and the tab may be
    // hidden), so a ResizeObserver toggles the button.
    renderValue(key, value) {
      const expanded = this.expanded.has(key);
      const pre = el('pre', { class: 'value' }, value);
      const more = el(
        'button',
        {
          class: 'more',
          onclick: () => {
            if (expanded) this.expanded.delete(key);
            else this.expanded.add(key);
            this.renderBody();
          },
        },
        svgIcon('0 0 512 512', ICON_CHEVRONS),
        expanded ? 'View less' : 'View more',
      );
      const clip = el('div', { class: `clip ${expanded ? 'expanded' : ''}` }, pre, more);
      this.overflow.observe(pre);
      return clip;
    }
  }

  // LeetCode's per-case icons (Font Awesome square-xmark / check).
  const ICON_FAIL =
    'M64 32C28.7 32 0 60.7 0 96v320c0 35.3 28.7 64 64 64h320c35.3 0 64-28.7 64-64V96c0-35.3-28.7-64-64-64H64zm79 143' +
    'c9.4-9.4 24.6-9.4 33.9 0l47 47 47-47c9.4-9.4 24.6-9.4 33.9 0s9.4 24.6 0 33.9l-47 47 47 47c9.4 9.4 9.4 24.6 0 33.9' +
    's-24.6 9.4-33.9 0l-47-47-47 47c-9.4 9.4-24.6 9.4-33.9 0s-9.4-24.6 0-33.9l47-47-47-47c-9.4-9.4-9.4-24.6 0-33.9z';
  const ICON_PASS =
    'M438.6 105.4c12.5 12.5 12.5 32.8 0 45.3l-256 256c-12.5 12.5-32.8 12.5-45.3 0l-128-128c-12.5-12.5-12.5-32.8 0-45.3' +
    's32.8-12.5 45.3 0L160 338.7 393.4 105.4c12.5-12.5 32.8-12.5 45.3 0z';
  // Values taller than this (8 lines) collapse behind "View more", as on LeetCode.
  const COLLAPSED_HEIGHT = 160;
  // Font Awesome chevrons-down; flipped for "View less".
  const ICON_CHEVRONS =
    'M239 465c9.4 9.4 24.6 9.4 33.9 0L465 273c9.4-9.4 9.4-24.6 0-33.9s-24.6-9.4-33.9 0l-175 175L81 239' +
    'c-9.4-9.4-24.6-9.4-33.9 0s-9.4 24.6 0 33.9L239 465zM47 81L239 273c9.4 9.4 24.6 9.4 33.9 0L465 81' +
    'c9.4-9.4 9.4-24.6 0-33.9s-24.6-9.4-33.9 0l-175 175L81 47c-9.4-9.4-24.6-9.4-33.9 0s-9.4 24.6 0 33.9z';
  // LeetCode's "Diff" toggle glyph.
  const ICON_DIFF =
    'M1.221 12.377a.421.421 0 01-.421-.421V3.622c0-.233.188-.422.421-.422h1.525c.756 0 1.328.206 1.714.619.396.412.593' +
    '.997.593 1.753v4.292c0 .86-.21 1.495-.631 1.907-.413.404-1.01.606-1.792.606H1.221zm.894-7.94v6.703h.605c.37 0 .632' +
    '-.09.787-.27.154-.19.232-.482.232-.877V5.572c0-.361-.073-.64-.22-.838-.146-.198-.412-.296-.799-.296h-.605zM7.019 ' +
    '12.377a.421.421 0 01-.422-.421V6.264c0-.233.189-.422.422-.422h.472c.232 0 .421.19.421.422v5.692a.421.421 0 01-.421' +
    '.421h-.472zm0-7.862a.421.421 0 01-.422-.421v-.472c0-.233.189-.422.422-.422h.472c.232 0 .421.189.421.422v.472a.421' +
    '.421 0 01-.421.42h-.472zM10.125 12.377a.421.421 0 01-.421-.421V6.874H9.48a.421.421 0 01-.42-.422v-.188c0-.233.188' +
    '-.422.42-.422h.224v-.889c0-.318.047-.584.141-.799.095-.223.224-.408.387-.554.155-.146.33-.25.529-.31.206-.06.416' +
    '-.09.631-.09h.184c.233 0 .422.189.422.422v.394a.421.421 0 01-.421.422h-.172c-.258 0-.387.15-.387.45v.954h.98v1.032' +
    'h-.98v5.082a.421.421 0 01-.421.421h-.472z' +
    'M13.327 12.377a.421.421 0 01-.421-.421V6.874h-.99V5.842h.99v-.889c0-.318.047-.584.141-.799a1.53 1.53 0 01.387-.554' +
    'c.155-.146.33-.25.528-.31.207-.06.417-.09.632-.09h.184c.233 0 .422.189.422.422v.394a.421.421 0 01-.421.422h-.172' +
    'c-.258 0-.387.15-.387.45v.954h.558c.233 0 .422.19.422.422v.188a.421.421 0 01-.421.422h-.559v5.082a.421.421 0 01' +
    '-.421.421h-.472z';
  const FAILED = new Set(['mismatch', 'runtime_error', 'timeout', 'harness_error']);

  function caseIcon(verdict) {
    const d = verdict.startsWith('match') ? ICON_PASS : FAILED.has(verdict) ? ICON_FAIL : null;
    if (!d) return el('span', { class: `dot ${verdict}` });
    return svgIcon('0 0 448 512', d, `mark ${d === ICON_PASS ? 'good' : 'bad'}`);
  }

  function svgIcon(viewBox, d, cls) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', viewBox);
    if (cls) svg.setAttribute('class', cls);
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
    return svg;
  }

  // Marks the spans of `actual` and `expected` that differ (everything
  // between their common prefix and common suffix), like LeetCode's diff.
  function highlightDiff(actual, expected) {
    let start = 0;
    while (start < actual.length && start < expected.length && actual[start] === expected[start]) start++;
    let end = 0;
    while (
      end < actual.length - start &&
      end < expected.length - start &&
      actual[actual.length - 1 - end] === expected[expected.length - 1 - end]
    ) {
      end++;
    }
    const mark = (text, cls) => {
      const mid = text.slice(start, text.length - end);
      return mid ? [text.slice(0, start), el('span', { class: cls }, mid), text.slice(text.length - end)] : text;
    };
    return { actual: mark(actual, 'diff removed'), expected: mark(expected, 'diff added') };
  }

  function formatMs(ms) {
    // Worker timers are coarse (~0.1 ms) without cross-origin isolation.
    if (ms < 1) return '<1 ms';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
  }

  LL.Panel = Panel;
})();

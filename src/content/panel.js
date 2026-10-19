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
      this.state = { phase: 'idle', cases: [], selected: 0, runtime: null, runtimeState: 'idle' };

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
      const sub = `${cases.length} case${cases.length === 1 ? '' : 's'} · ${formatMs(time)} total (local)`;
      if (verdicts.includes('timeout')) return { cls: 'bad', title: 'Time Limit Exceeded', sub };
      if (verdicts.includes('runtime_error')) return { cls: 'bad', title: 'Runtime Error', sub };
      if (verdicts.includes('harness_error')) return { cls: 'bad', title: 'Invalid Testcase', sub };
      if (verdicts.includes('mismatch')) {
        const ok = verdicts.filter((v) => v.startsWith('match')).length;
        const known = verdicts.filter((v) => v.startsWith('match') || v === 'mismatch').length;
        return { cls: 'bad', title: 'Wrong Answer', sub: `${ok}/${known} match expected · ${sub}` };
      }
      if (verdicts.length && verdicts.every((v) => v.startsWith('match'))) {
        return { cls: 'good', title: 'Accepted', sub: `all match expected · ${sub}` };
      }
      const known = verdicts.filter((v) => v.startsWith('match')).length;
      return {
        cls: 'neutral',
        title: 'Finished',
        sub: known
          ? `${known} match expected, ${verdicts.length - known} without known output · ${sub}`
          : `no expected outputs known for these inputs · ${sub}`,
      };
    }

    renderBody() {
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
        parts.push(
          el('div', { class: `summary ${s.cls}` }, el('strong', {}, s.title), s.sub && el('span', {}, s.sub)),
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
              title: VERDICT_LABEL[c.verdict],
              onclick: () => {
                this.state.selected = i;
                this.renderBody();
              },
            },
            el('span', { class: `dot ${c.verdict}` }),
            `Case ${i + 1}`,
          ),
        ),
      );
    }

    renderCase(c) {
      const names = this.state.paramNames ?? [];
      const r = c.result;
      const field = (label, value, cls = '') =>
        el('div', { class: 'field' }, el('div', { class: 'label' }, label), el('pre', { class: `value ${cls}` }, value));
      const out = [
        el('div', { class: `verdict ${c.verdict}` }, VERDICT_LABEL[c.verdict],
          r && r.timeMs != null && el('span', { class: 'time' }, formatMs(r.timeMs))),
        el('div', { class: 'label' }, 'Input'),
        ...c.lines.map((line, i) => field(`${names[i] ?? `arg${i + 1}`} =`, line)),
      ];
      if (r?.error) out.push(field('Error', r.error, 'error'));
      if (r?.stdout) out.push(field('Stdout', r.stdout));
      if (r && r.output != null) {
        const cls = c.verdict === 'mismatch' ? 'bad' : c.verdict.startsWith('match') ? 'good' : '';
        out.push(field('Output', r.output, cls));
      }
      if (c.expected != null) out.push(field('Expected (from problem examples)', c.expected));
      return el('div', { class: 'case' }, out);
    }
  }

  function formatMs(ms) {
    // Worker timers are coarse (~0.1 ms) without cross-origin isolation.
    if (ms < 1) return '<1 ms';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
  }

  LL.Panel = Panel;
})();

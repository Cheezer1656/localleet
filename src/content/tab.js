// Docks LocalLeet's results as a tab next to LeetCode's "Test Result" tab.
//
// LeetCode lays out its panes with flexlayout-react: each tabset has a tab bar
// and an empty `.flexlayout__tabset_content` placeholder, while the tab
// contents are absolutely positioned siblings toggled with `display: none`.
// We never touch React-owned nodes beyond appending our own: the tab button
// is a clone of "Test Result" (so it inherits the exact styling), our content
// lives in the placeholder, and while our tab is active a stylesheet rule
// hides the tabset's native panes.
(() => {
  const LL = (globalThis.LocalLeet ??= {});

  const ANCHOR_TEXT = /Test Result|测试结果/;
  const SELECTED = 'flexlayout__tab_button--selected';
  const UNSELECTED = 'flexlayout__tab_button--unselected';
  const ICON =
    'M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 9.5v-6Z' +
    'm4.75 1.2v3.6L9.9 6.5 6.75 4.7ZM1 12.5h14v1H1v-1Z';
  // Events that flexlayout/React would otherwise interpret (select, drag, …).
  const SWALLOWED = ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'contextmenu'];

  class ResultsTab {
    constructor({ label, content, onMount }) {
      this.label = label;
      this.content = content;
      this.onMount = onMount;
      this.active = false;
      this.button = null;
      this.divider = null;
      this.container = null;
      this.tabset = null;
      this.tabsetPath = null;
      this.suppressed = null;
      this.style = document.createElement('style');
      this.style.id = 'localleet-tab-style';
      this.observer = new MutationObserver(() => this.checkNativeSelection());

      // Any interaction that selects a native tab in our tabset hands control back.
      document.addEventListener('pointerdown', (e) => this.onPointerDown(e), true);
      // LeetCode's own Run/Submit switch to its result tab without a tab click.
      document.addEventListener('click', (e) => this.onClick(e), true);
      document.addEventListener('keydown', (e) => this.onKeyDown(e), true);
    }

    anchorButton() {
      return [...document.querySelectorAll('.flexlayout__tab_button')].find(
        (b) => b !== this.button && ANCHOR_TEXT.test(b.textContent),
      );
    }

    // Inject (or re-inject after a re-render) the tab. Returns whether the tab
    // is available, i.e. whether LeetCode's result tabset exists right now.
    ensure() {
      const anchor = this.anchorButton();
      const tabset = anchor?.closest('.flexlayout__tabset');
      const placeholder = tabset?.querySelector(':scope > .flexlayout__tabset_content');
      if (!placeholder) return false;

      this.tabset = tabset;
      const path = anchor.dataset.layoutPath?.replace(/\/[^/]*$/, '') ?? null;
      if (path !== this.tabsetPath) {
        this.tabsetPath = path;
        if (this.active) this.updateStyle();
      }
      if (!this.button?.isConnected || this.button.parentElement !== anchor.parentElement) {
        this.injectButton(anchor);
      }
      if (this.container?.parentElement !== placeholder) {
        this.container?.remove();
        this.container = document.createElement('div');
        this.container.id = 'localleet-tab-content';
        // `contain: size` keeps our content from growing the placeholder (a
        // flex item with min-height: auto), which would push the tabset's tab
        // bar out of view; the panel scrolls internally instead.
        this.container.style.cssText = 'width:100%;height:100%;overflow:hidden;contain:size;';
        // The tabset has a wheel listener that calls preventDefault (native
        // panes are outside it, ours is inside), which would block scrolling.
        this.container.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
        placeholder.append(this.container);
      }
      if (this.content.parentElement !== this.container) {
        this.container.append(this.content);
        this.onMount?.();
      }
      this.render();
      return true;
    }

    injectButton(anchor) {
      this.button?.remove();
      this.divider?.remove();

      const button = anchor.cloneNode(true);
      button.id = 'localleet-tab-button';
      button.removeAttribute('data-layout-path');
      button.title = 'LocalLeet: results of running your code locally';
      for (const node of button.querySelectorAll('[id]')) node.removeAttribute('id');
      const labels = button.querySelectorAll('.medium, .normal');
      if (labels.length) {
        for (const node of labels) node.textContent = this.label;
      } else {
        (button.querySelector('.flexlayout__tab_button_content') ?? button).textContent = this.label;
      }
      const svg = button.querySelector('svg');
      if (svg) {
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.classList.remove('fa-terminal');
        svg.style.color = '#ffa116';
        svg.replaceChildren();
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('fill', 'currentColor');
        path.setAttribute('d', ICON);
        svg.append(path);
      }
      for (const type of SWALLOWED) {
        button.addEventListener(type, (e) => {
          e.stopPropagation();
          if (type === 'click') this.activate();
        });
      }

      const divider = anchor.parentElement.querySelector('.flexlayout__tabset_tab_divider');
      this.divider = divider ? divider.cloneNode(true) : null;
      this.button = button;
      anchor.parentElement.append(...[this.divider, button].filter(Boolean));
    }

    activate() {
      if (!this.ensure()) return false;
      if (this.active) return true;
      this.active = true;
      // Make the natively selected tab look unselected while ours is shown.
      const selected = this.nativeSelectedButton();
      if (selected) {
        this.suppressed = { el: selected, className: selected.className };
        selected.classList.replace(SELECTED, UNSELECTED);
      }
      this.visiblePane = this.visibleNativePane();
      this.updateStyle();
      this.render();
      // Watch the tab buttons and the panes themselves, not their (busy) contents.
      this.observer.observe(this.tabset, { attributes: true, attributeFilter: ['class'], subtree: true });
      for (const pane of this.nativePanes()) {
        this.observer.observe(pane, { attributes: true, attributeFilter: ['style'] });
      }
      return true;
    }

    deactivate() {
      if (!this.active) return;
      this.active = false;
      this.observer.disconnect();
      this.style.textContent = '';
      const suppressed = this.suppressed;
      this.suppressed = null;
      // Restore the native selection unless LeetCode already selected another tab.
      if (suppressed?.el.isConnected && !this.nativeSelectedButton()) {
        suppressed.el.className = suppressed.className;
      }
      this.render();
    }

    render() {
      if (this.button) {
        this.button.classList.remove(SELECTED, UNSELECTED);
        this.button.classList.add(this.active ? SELECTED : UNSELECTED);
      }
      if (this.container) this.container.style.display = this.active ? 'block' : 'none';
    }

    updateStyle() {
      if (!this.style.isConnected) (document.head ?? document.documentElement).append(this.style);
      this.style.textContent = this.tabsetPath
        ? `.flexlayout__tab[data-layout-path^=${JSON.stringify(this.tabsetPath + '/')}] { display: none !important; }`
        : '';
    }

    nativeTabButtons() {
      return [...(this.tabset?.querySelectorAll('.flexlayout__tab_button') ?? [])].filter(
        (b) => b !== this.button,
      );
    }

    nativeSelectedButton() {
      return this.nativeTabButtons().find((b) => b.classList.contains(SELECTED)) ?? null;
    }

    nativePanes() {
      if (!this.tabsetPath || !this.tabset?.parentElement) return [];
      return [...this.tabset.parentElement.querySelectorAll(':scope > .flexlayout__tab')].filter((pane) =>
        pane.dataset.layoutPath?.startsWith(this.tabsetPath + '/'),
      );
    }

    visibleNativePane() {
      return this.nativePanes().find((pane) => pane.style.display !== 'none')?.dataset.layoutPath ?? null;
    }

    // LeetCode switched tabs programmatically (e.g. after its own Run).
    checkNativeSelection() {
      if (!this.active) return;
      if (this.nativeSelectedButton() || this.visibleNativePane() !== this.visiblePane) {
        this.deactivate();
      }
    }

    onPointerDown(e) {
      if (!this.active || !(e.target instanceof Element)) return;
      const tab = e.target.closest('.flexlayout__tab_button');
      if (tab && tab !== this.button && this.tabset?.contains(tab)) this.deactivate();
    }

    onClick(e) {
      if (!this.active || !(e.target instanceof Element)) return;
      if (e.target.closest('[data-e2e-locator="console-run-button"], [data-e2e-locator="console-submit-button"]')) {
        this.deactivate();
      }
    }

    onKeyDown(e) {
      // LeetCode's Run (Ctrl/⌘+') and Submit (Ctrl/⌘+Enter) shortcuts.
      if (!this.active || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      if (e.code === 'Quote' || e.key === 'Enter') this.deactivate();
    }
  }

  LL.ResultsTab = ResultsTab;
})();

# LocalLeet

A browser extension for Chrome and Firefox that runs LeetCode testcases **locally, in your browser**, using
WebAssembly builds of language toolchains. Python (via [Pyodide](https://pyodide.org)) and C++ (via Clang/LLD from
[YoWASP](https://yowasp.org)) are supported, and the code is laid out so other languages can be added.

- Adds a **Local** button next to LeetCode's Run button, and a shortcut: **Ctrl/⌘ + Shift + '**.
- Shows results in a **LocalLeet** tab next to LeetCode's own *Test Result* tab. A floating panel is used only if
  that tab can't be found.
- Runs your code from the editor against the testcases in LeetCode's **Testcase** panel, including ones you add or edit.
- Compares each output against the **expected output from the problem's examples** when the input matches an
  example. For problems that say "in any order", it also accepts the answer in any order.
- Shows output, stdout and a filtered traceback per case, with LeetCode-style verdicts (Accepted, Wrong Answer,
  Runtime Error, Time Limit Exceeded, Compile Error).
- Handles plain functions, in-place (`void`) problems, `ListNode`/`TreeNode` inputs and outputs, design problems
  (`["LRUCache","put",...]`), and the common custom-judge problems (linked list cycle, intersection, LCA, clone
  graph).
- Mirrors LeetCode's Python environment: the usual standard-library star imports, `typing`, and `sortedcontainers`.
- Mirrors LeetCode's C++ environment: C++23 at `-O2`, the whole standard library (including `<bits/stdc++.h>`),
  `using namespace std`, and `ListNode`/`TreeNode`. Runtime errors come out the way LeetCode's sanitizers report
  them, e.g. `Line 4: Char 18: runtime error: signed integer overflow: ...` or `member access within null pointer`.

## Install

```sh
npm install
npm run build          # -> dist/chrome and dist/firefox
npm run package        # also writes dist/localleet-<browser>-<version>.zip
```

- **Chrome**: open `chrome://extensions`, enable *Developer mode*, choose *Load unpacked* and select `dist/chrome`.
- **Firefox** (140+): open `about:debugging#/runtime/this-firefox`, choose *Load Temporary Add-on* and select
  `dist/firefox/manifest.json`.

Settings (per-testcase time limit, and whether to preload the toolchain) are on the extension's options page.

## Development

```sh
npm run dev            # watch src/ and rebuild both browsers as dev builds
npm test               # harness unit tests: Python (CPython) and C++ (WebAssembly Clang in Node)
npm run test:firefox   # live end-to-end test of dist/firefox in headless Firefox
```

Dev builds reload themselves. A content script pings the extension once a second, and when `dev/build-id.txt`
changes the extension reloads and so does the LeetCode tab. Load the dev build once and every change in
`src/` takes effect on its own.

## Architecture

Everything under `src/` is shared between browsers. The only per-browser pieces are the manifest overlays in
`src/manifest/` and a small Chrome service worker (`src/background/chrome.js`).

```
LeetCode tab                                     Extension context (outside the page)
┌──────────────────────────────────────────┐     ┌──────────────────────────────────────────┐
│ content/page-bridge.js  (MAIN world)     │     │ runner/runner.html + runner.js           │
│   reads Monaco code + testcase editor    │     │   Chrome: offscreen document             │
│            ▲ postMessage                 │     │   Firefox: background page               │
│ content/*.js            (isolated world) │Port │                                          │
│   leetcode.js  problem metadata (GraphQL)├────►│   one Web Worker per language, job queue,│
│   compare.js   output vs expected        │     │   per-testcase timeout (kill + respawn)  │
│   panel.js     results UI (shadow DOM)   │     │        │                                 │
│   tab.js       docks it as a LeetCode tab│     │        ▼                                 │
│   main.js      wiring, button, shortcut  │     │ languages/python/worker.js  (Pyodide)    │
└──────────────────────────────────────────┘     │ languages/python/driver.py  (harness)    │
                                                 │ languages/cpp/worker.js     (Clang+WASI) │
                                                 │ languages/cpp/prelude.h     (harness)    │
                                                 └──────────────────────────────────────────┘
```

- **Why not run it in an iframe in the page?** That was the first design. Other extensions that attach the
  debugger to the tab (Claude in Chrome, for example) remove foreign extension frames, so the runner lives in an
  offscreen document on Chrome and in the background page on Firefox. Both load the same `runner.html`.
- **The LocalLeet tab**: LeetCode lays out its panes with flexlayout-react. `tab.js` clones the *Test Result*
  tab button, so the new tab inherits LeetCode's styling, and mounts the results into the tabset's empty
  `.flexlayout__tabset_content` placeholder. While the tab is active, an injected rule hides that tabset's native
  panes. Clicking a native tab, or using LeetCode's own Run/Submit, hands control back. React-owned nodes are never
  removed; the only change to one is a temporary selected/unselected class swap on the native tab button.
- **CSP**: MV3 forbids `eval`, so the extension pages only allow `'wasm-unsafe-eval'`. Pyodide's core interpreter
  needs nothing more. Its `eval` paths are only used to dynamically link binary packages, which we don't load.
- **The harness** (`driver.py`) is plain CPython code. It parses the raw testcase lines according to the problem's
  `metaData` (types such as `integer[]`, `ListNode`, `TreeNode`, `list<list<string>>`, `double`), calls your
  `Solution`, and serializes the result the way LeetCode prints it.
- **The C++ toolchain** compiles each submission with Clang/LLD built for WebAssembly (`@yowasp/clang`, about
  100 MB) into a WASI program, then runs it in the worker under a small WASI host (`cpp/wasi.js`).
  - `cpp/codegen.js` generates the glue for each problem from its `metaData`: it maps parameter types to C++ types
    and emits the calls into your `Solution` or design class. JSON parsing, argument conversion and output
    formatting are C++ overloads in `cpp/prelude.h`.
  - `prelude.h` holds the standard headers, the LeetCode types and the harness. The build precompiles it into a PCH
    (`scripts/cpp-pch.mjs`, cached in `.cache/cpp/`), which halves compile time. `cpp/flags.js` holds the flags,
    shared by the build and the worker, because a PCH only loads with the exact flags it was built with.
  - The program reports each testcase to the worker over file descriptor 3, so `cout`/`printf` output stays separate.
    After a crash the worker instantiates the module again and continues with the next testcase.
  - The sysroot has no sanitizer or exception runtime, so `prelude.h` supplies its own. UBSan handlers report
    null-pointer member access, signed overflow, bad shifts, division by zero, out-of-bounds C arrays and missing
    `return`s with your line numbers. libc++'s debug hardening mode catches out-of-range `operator[]`, `front()`/`back()`
    on empty containers, and so on. Small `__cxa_throw` stubs make an uncaught exception terminate with the usual message.

### Adding a language

1. Create `src/languages/<id>/worker.js`, a module worker that speaks the worker protocol documented at the top
   of `src/runner/runner.js`:
   - it posts `{type:'ready', runtime}` once loaded;
   - it accepts `{type:'run', code, meta, slug, cases}`;
   - it posts one `{type:'case', index, result}` per testcase, then `{type:'done', compileError?}`;
   - compiled languages may post `{type:'compiled'}` after building, so that compile time isn't counted against
     the first testcase's time limit.
2. Put the language's harness next to it. It must parse inputs from `meta` and print outputs in LeetCode's format,
   the way `driver.py` does.
3. Register it in `src/languages/index.js` with the LeetCode language slugs it handles (for example
   `['javascript']`).
4. If the toolchain has vendored files, add them to `scripts/build.mjs`.

The content scripts, panel, runner and timeouts need no changes.

## Limitations

- Expected outputs are only known for inputs that match the problem's examples. LeetCode's reference solution
  isn't available offline, so outputs for custom inputs are shown without a verdict.
- Problems with multiple valid answers are compared as exact matches, apart from the "any order" handling above.
- Local timings come from WebAssembly in a worker. They aren't comparable to LeetCode's runtime numbers.
- LeetCode's "Python" (Python 2) option runs on Python 3.
- C++ specifics:
  - The target is 32-bit WebAssembly, so `long` and `size_t` are 32 bits (they're 64 bits on LeetCode). Use
    `long long`. An overflow in a `long` adds a note saying so.
  - The WebAssembly libc++ is built without exception support. `throw` compiles, but `catch` blocks never run, so
    any thrown exception terminates the program.
  - There is no AddressSanitizer. Out-of-range container access is caught by libc++ hardening, but a stray raw
    pointer may give garbage instead of an error.
  - Recursion depth is limited by the browser's WebAssembly stack, which is smaller than LeetCode's.
  - Each run compiles first, which takes about 2 s. Re-running unchanged code with different testcases reuses the
    last build.
  - The toolchain adds about 130 MB to the extension: Clang/LLD with its sysroot, plus the 30 MB PCH.
- `leetcode.cn` is matched but hasn't been tested.

// Python language worker: hosts Pyodide and the LeetCode harness (driver.py).
// Speaks the generic worker protocol documented in src/runner/runner.js.

import { loadPyodide } from '../../vendor/pyodide/pyodide.mjs';

const VENDOR = new URL('../../vendor/', import.meta.url);

async function boot() {
  const pyodide = await loadPyodide({
    indexURL: new URL('pyodide/', VENDOR).href,
    stdout: () => {},
    stderr: () => {},
  });

  // LeetCode's Python environment ships sortedcontainers; it is pure Python,
  // so unpack the bundled wheel straight into site-packages.
  const wheel = await fetch(new URL('wheels/sortedcontainers-2.4.0-py2.py3-none-any.whl', VENDOR));
  if (wheel.ok) {
    pyodide.unpackArchive(await wheel.arrayBuffer(), 'wheel');
  }

  const driverSource = await (await fetch(new URL('./driver.py', import.meta.url))).text();
  pyodide.FS.writeFile('/home/pyodide/localleet_driver.py', driverSource);
  pyodide.runPython('import sys; sys.path.insert(0, "/home/pyodide")');
  const driver = pyodide.pyimport('localleet_driver');
  const version = pyodide.runPython('import sys; sys.version.split()[0]');
  return { pyodide, driver, version };
}

const ready = boot();

ready.then(
  ({ version }) => postMessage({ type: 'ready', runtime: `Python ${version} (Pyodide)` }),
  (err) => postMessage({ type: 'fatal', error: String(err?.stack || err) }),
);

self.onmessage = async ({ data }) => {
  if (data.type !== 'run') return;
  const { driver } = await ready;
  const { code, meta, cases, slug } = data;
  let index = 0;
  const onResult = (json) => {
    postMessage({ type: 'case', index: index++, result: normalize(JSON.parse(json)) });
  };
  try {
    const out = JSON.parse(
      driver.run_all(code, JSON.stringify(meta), JSON.stringify(cases), slug ?? null, onResult),
    );
    postMessage({ type: 'done', compileError: out.compile_error ?? null });
  } catch (err) {
    postMessage({ type: 'done', compileError: null, internalError: String(err?.message || err) });
  }
};

function normalize(r) {
  return {
    status: r.status,
    output: r.output,
    stdout: r.stdout,
    error: r.error,
    timeMs: r.time_ms,
  };
}

// C++ language worker: hosts Clang/LLD (WebAssembly build from @yowasp/clang)
// and runs the compiled submission under a small WASI host.
// Speaks the generic worker protocol documented in src/runner/runner.js.

import { runClang, version } from '../../vendor/clang/bundle.js';
import { createToolchain } from './toolchain.js';

const VENDOR = new URL('../../vendor/', import.meta.url);

const text = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url}: ${res.status}`);
  return res.text();
};

async function loadPch() {
  try {
    const res = await fetch(new URL('cpp/prelude.pch', VENDOR));
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

const WARMUP = {
  code: 'class Solution { public: int f(int n) { return n; } };',
  meta: { name: 'f', params: [{ name: 'n', type: 'integer' }], return: { type: 'integer' } },
  slug: null,
  cases: [['1']],
};

async function boot() {
  const [, prelude, stdcpp, pch] = await Promise.all([
    runClang(null, {}, { fetchProgress: () => {} }), // fetch and compile the toolchain
    text(new URL('./prelude.h', import.meta.url)),
    text(new URL('./include/bits/stdc++.h', import.meta.url)),
    loadPch(),
  ]);
  // A first compile warms up the compiler and checks that the precompiled
  // prelude loads; if it doesn't, compile the prelude from source instead.
  let toolchain = createToolchain(runClang, { prelude, stdcpp, pch });
  if (pch) {
    const { compileError } = await toolchain.run(WARMUP, () => {});
    if (compileError) {
      console.warn('LocalLeet: precompiled C++ prelude failed to load; compiling it from source.', compileError);
      toolchain = createToolchain(runClang, { prelude, stdcpp, pch: null });
    }
  }
  return toolchain;
}

const ready = boot();

ready.then(
  () => postMessage({ type: 'ready', runtime: `Clang ${version.split('.')[0]} · C++23 (WebAssembly)` }),
  (err) => postMessage({ type: 'fatal', error: String(err?.stack || err) }),
);

self.onmessage = async ({ data }) => {
  if (data.type !== 'run') return;
  const toolchain = await ready;
  try {
    const out = await toolchain.run(data, (index, result) => {
      postMessage({ type: 'case', index, result });
    }, () => postMessage({ type: 'compiled' }));
    postMessage({ type: 'done', compileError: out.compileError ?? null });
  } catch (err) {
    postMessage({ type: 'done', compileError: null, internalError: String(err?.message || err) });
  }
};

// C++ toolchain: compiles a submission with Clang (WebAssembly build from
// @yowasp/clang) against the precompiled prelude, then runs the testcases.
// Shared by the language worker and the Node tests, so it takes Clang and the
// prelude files as arguments instead of fetching them itself.

import { COMPILE_FLAGS, LINK_FLAGS, PCH, PRELUDE } from './flags.js';
import { generateSource, UnsupportedProblem } from './codegen.js';
import { runWasi } from './wasi.js';

const MAX_STDOUT = 64 * 1024;

// `files`: { prelude, stdcpp, pch } — prelude.h and bits/stdc++.h sources and
// the PCH bytes (null to compile the prelude from source every time).
export function createToolchain(runClang, files) {
  const tree = {
    [PRELUDE]: files.prelude,
    include: { bits: { 'stdc++.h': files.stdcpp } },
  };
  const include = files.pch
    ? ['-include-pch', PCH, '-Xclang', '-fno-validate-pch']
    : ['-include', PRELUDE];
  if (files.pch) tree[PCH] = files.pch;

  let cached = { source: null, module: null };

  // -> { module } | { compileError }
  async function compile(source) {
    if (cached.source === source) return { module: cached.module };
    const stderr = [];
    const decoder = new TextDecoder();
    let out;
    try {
      out = await runClang(
        ['clang++', ...COMPILE_FLAGS, ...include, 'solution.cpp', ...LINK_FLAGS, '-o', 'solution.wasm'],
        { ...tree, 'solution.cpp': source },
        {
          stdout: (b) => b && stderr.push(decoder.decode(b, { stream: true })),
          stderr: (b) => b && stderr.push(decoder.decode(b, { stream: true })),
          decodeASCII: false,
        },
      );
    } catch (err) {
      if (err?.code === undefined) throw err; // not a compiler exit status
      return { compileError: formatDiagnostics(stderr.join('')) || String(err.message || err) };
    }
    const module = await WebAssembly.compile(out['solution.wasm']);
    cached = { source, module };
    return { module };
  }

  // Runs one batch. onCase(index, result) is called as each testcase
  // finishes, onCompiled once the program is built. Returns { compileError? }.
  async function run({ code, meta, slug, cases }, onCase, onCompiled = () => {}) {
    let source;
    try {
      source = generateSource(code, meta, slug);
    } catch (err) {
      if (!(err instanceof UnsupportedProblem)) throw err;
      cases.forEach((_, i) =>
        onCase(i, { status: 'harness_error', output: null, stdout: '', error: err.message, timeMs: 0 }),
      );
      return {};
    }
    const { module, compileError } = await compile(source);
    if (compileError) return { compileError };
    onCompiled();
    execute(module, cases, onCase);
    return {};
  }

  return { run, compile };
}

function stdinFor(cases) {
  const lines = [String(cases.length)];
  for (const c of cases) {
    lines.push(String(c.length));
    for (const line of c) lines.push(normalizeLine(line));
  }
  return new TextEncoder().encode(lines.join('\n') + '\n');
}

// A few legacy problems use bare words for strings; quote them so the harness
// only ever sees JSON.
function normalizeLine(line) {
  const trimmed = line.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    return trimmed && !/^[[{"]/.test(trimmed) ? JSON.stringify(trimmed) : trimmed;
  }
}

// Runs the compiled module over all cases. A trap ends the instance; the
// case it happened in gets a runtime error and a fresh instance continues
// with the next case.
function execute(module, cases, onCase) {
  const stdin = stdinFor(cases);
  let next = 0;
  while (next < cases.length) {
    const startedAt = next;
    let current = -1;
    let finished = false;
    let caseStart = 0;
    let stdout = '';
    let stderr = '';
    let frames = '';
    const decoders = { 1: new TextDecoder(), 2: new TextDecoder(), 3: new TextDecoder() };

    const report = (status, fields) => {
      finished = true;
      next = current + 1;
      onCase(current, {
        status,
        output: null,
        stdout: truncate(stdout),
        error: null,
        timeMs: performance.now() - caseStart,
        ...fields,
      });
    };

    const onFrame = (line) => {
      const tag = line[0];
      const payload = line.slice(2);
      if (tag === 'B') {
        current = Number(payload);
        finished = false;
        stdout = '';
        stderr = '';
        caseStart = performance.now();
      } else if (tag === 'R') {
        report('ok', { output: JSON.parse(payload) });
      } else if (tag === 'H') {
        report('harness_error', { error: JSON.parse(payload) });
      } else if (tag === 'E') {
        report('runtime_error', { error: JSON.parse(payload) });
      }
    };

    const onWrite = (fd, chunk) => {
      const text = decoders[fd]?.decode(chunk, { stream: true }) ?? '';
      if (fd === 3) {
        frames += text;
        let nl;
        while ((nl = frames.indexOf('\n')) !== -1) {
          onFrame(frames.slice(0, nl));
          frames = frames.slice(nl + 1);
        }
      } else if (stdout.length < MAX_STDOUT * 2) {
        stdout += text;
        if (fd === 2) stderr += text;
      }
    };

    let failure = null;
    let exitCode = 0;
    try {
      exitCode = runWasi(module, { args: ['solution', String(next)], stdin, onWrite });
    } catch (err) {
      failure = err;
    }

    if (current === -1) {
      // Died before the first case started (e.g. in a static initializer).
      current = next;
      caseStart = performance.now();
    }
    if (failure || exitCode !== 0) {
      if (!finished) {
        report('runtime_error', {
          error: stderr.trim() || (failure ? describeTrap(failure) : `Program exited with code ${exitCode}`),
        });
      }
    } else if (!finished && current < cases.length) {
      // The program returned in the middle of a case (exit(0) from user code).
      report('runtime_error', { error: 'Program exited before the testcase finished (exit(0) called?)' });
    }
    if (next <= startedAt) next = startedAt + 1; // always make progress
  }
}

function describeTrap(err) {
  const msg = String(err?.message || err);
  if (err instanceof RangeError || /call stack/i.test(msg)) {
    return "Runtime Error: stack overflow (recursion too deep for the browser's WebAssembly stack)";
  }
  if (/out of bounds/.test(msg)) {
    return 'Runtime Error: memory access out of bounds (invalid pointer, out-of-range index or stack overflow)';
  }
  if (/divide by zero/.test(msg)) return 'Runtime Error: integer division by zero';
  if (/integer overflow/.test(msg)) return 'Runtime Error: integer overflow in division';
  if (/unreachable/.test(msg)) return 'Runtime Error: program aborted';
  return `Runtime Error: ${msg}`;
}

function truncate(out) {
  return out.length > MAX_STDOUT ? out.slice(0, MAX_STDOUT) + '\n... (stdout truncated)' : out;
}

// Rewrites Clang diagnostics into LeetCode's "Line N: Char M:" style.
export function formatDiagnostics(text) {
  return text
    .split('\n')
    .filter((l) => !/^\d+ (error|warning)s? generated\.$/.test(l))
    .map((l) => l.replace(/^solution\.cpp:(\d+):(\d+): /, 'Line $1: Char $2: '))
    .join('\n')
    .trim();
}

// Builds dist/chrome and dist/firefox from the shared sources in src/.
//
//   node scripts/build.mjs [chrome|firefox ...] [--dev] [--watch] [--zip]
//
// Everything under src/ is shared; the only per-browser difference is the
// manifest overlay in src/manifest/<browser>.json (plus how the dev-only
// background script is declared).

import { cp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { watch } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPch } from './cpp-pch.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');
const CACHE = join(ROOT, '.cache');

const PYODIDE_FILES = [
  'pyodide.mjs',
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
];
// Clang/LLD for the C++ toolchain; bundle.js loads the rest relative to itself.
const CLANG_DIR = join(ROOT, 'node_modules', '@yowasp', 'clang', 'gen');
const CLANG_FILES = [
  'bundle.js',
  'llvm.core.wasm',
  'llvm.core2.wasm',
  'llvm.core3.wasm',
  'llvm.core4.wasm',
  'llvm-resources.tar',
];
const WHEELS = [
  {
    name: 'sortedcontainers-2.4.0-py2.py3-none-any.whl',
    url: 'https://files.pythonhosted.org/packages/32/46/9cb0e58b2deb7f82b84065f37f3bffeb12413f947f9388e4cac22c4621ce/sortedcontainers-2.4.0-py2.py3-none-any.whl',
  },
];

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const targets = args.filter((a) => !a.startsWith('--'));
const browsers = targets.length ? targets : ['chrome', 'firefox'];
const dev = flags.has('--dev') || flags.has('--watch');

function merge(base, overlay) {
  const out = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object'
        ? merge(base[k], v)
        : v;
  }
  return out;
}

const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
const exists = (p) => access(p).then(() => true, () => false);

async function fetchWheels() {
  await mkdir(join(CACHE, 'wheels'), { recursive: true });
  for (const { name, url } of WHEELS) {
    const dest = join(CACHE, 'wheels', name);
    if (await exists(dest)) continue;
    console.log(`downloading ${name}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  }
}

async function manifestFor(browser) {
  let manifest = merge(
    await readJson(join(SRC, 'manifest', 'base.json')),
    await readJson(join(SRC, 'manifest', `${browser}.json`)),
  );
  if (dev) {
    // Add the auto-reload helper next to each browser's own background.
    manifest.name += ' (dev)';
    if (browser === 'chrome') {
      manifest.background = { service_worker: 'dev/chrome-sw.js', type: 'module' };
    } else {
      manifest.background = { page: 'dev/firefox-background.html' };
    }
    manifest.content_scripts.push({
      matches: manifest.content_scripts[1].matches,
      js: ['dev/content-reload.js'],
      run_at: 'document_idle',
    });
  }
  return manifest;
}

async function build(browser, pch) {
  const out = join(DIST, browser);
  await rm(out, { recursive: true, force: true });
  await cp(SRC, out, {
    recursive: true,
    filter: (p) =>
      !p.includes('__pycache__') &&
      !p.startsWith(join(SRC, 'manifest')) &&
      (dev || !p.startsWith(join(SRC, 'dev'))) &&
      // Chrome-only glue is left out of the Firefox build.
      !(browser !== 'chrome' && p.startsWith(join(SRC, 'background'))),
  });
  await writeFile(join(out, 'manifest.json'), JSON.stringify(await manifestFor(browser), null, 2));

  const pyodideDir = join(out, 'vendor', 'pyodide');
  await mkdir(pyodideDir, { recursive: true });
  for (const f of PYODIDE_FILES) {
    await cp(join(ROOT, 'node_modules', 'pyodide', f), join(pyodideDir, f));
  }
  await cp(join(CACHE, 'wheels'), join(out, 'vendor', 'wheels'), { recursive: true });

  const clangDir = join(out, 'vendor', 'clang');
  await mkdir(clangDir, { recursive: true });
  for (const f of CLANG_FILES) await cp(join(CLANG_DIR, f), join(clangDir, f));
  await mkdir(join(out, 'vendor', 'cpp'), { recursive: true });
  await cp(pch, join(out, 'vendor', 'cpp', 'prelude.pch'));

  if (dev) {
    if (browser === 'chrome') {
      await writeFile(
        join(out, 'dev', 'chrome-sw.js'),
        "import '../background/chrome.js';\nimport './background.js';\n",
      );
    } else {
      await writeFile(
        join(out, 'dev', 'firefox-background.html'),
        '<!doctype html><meta charset="utf-8">\n' +
          '<script type="module" src="../runner/runner.js"></script>\n' +
          '<script src="background.js"></script>\n',
      );
    }
    await writeFile(join(out, 'dev', 'build-id.txt'), String(Date.now()));
  }

  if (flags.has('--zip')) {
    const version = (await readJson(join(out, 'manifest.json'))).version;
    const zip = join(DIST, `localleet-${browser}-${version}.zip`);
    await rm(zip, { force: true });
    execFileSync('zip', ['-qr', zip, '.'], { cwd: out });
    console.log(`packed ${zip}`);
  }
  console.log(`built ${browser}${dev ? ' (dev)' : ''} -> ${out}`);
}

async function buildAll() {
  const pch = await buildPch();
  for (const b of browsers) await build(b, pch);
}

await fetchWheels();
await buildAll();

if (flags.has('--watch')) {
  let timer = null;
  watch(SRC, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => buildAll().catch((e) => console.error(e)), 150);
  });
  console.log('watching src/ for changes…');
}

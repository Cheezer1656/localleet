// Precompiles the C++ prelude (src/languages/cpp/prelude.h) with the same
// WebAssembly Clang the extension ships, so the extension only has to compile
// the submission itself. Cached in .cache/cpp/ by prelude, flags and Clang version.

import { mkdir, readFile, writeFile, access, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CPP = join(ROOT, 'src', 'languages', 'cpp');
const CACHE = join(ROOT, '.cache', 'cpp');

export async function preludeFiles() {
  return {
    prelude: await readFile(join(CPP, 'prelude.h'), 'utf8'),
    stdcpp: await readFile(join(CPP, 'include', 'bits', 'stdc++.h'), 'utf8'),
  };
}

// Returns the path of an up-to-date prelude.pch, building it if needed.
export async function buildPch({ log = console.log } = {}) {
  const { runClang, version } = await import('@yowasp/clang');
  const { COMPILE_FLAGS, PRELUDE, PCH } = await import(join(CPP, 'flags.js'));
  const files = await preludeFiles();
  const key = createHash('sha256')
    .update(JSON.stringify([version, COMPILE_FLAGS, files]))
    .digest('hex')
    .slice(0, 16);
  const out = join(CACHE, `prelude-${key}.pch`);
  if (await access(out).then(() => true, () => false)) return out;

  log(`precompiling C++ prelude (clang ${version})…`);
  const stderr = [];
  let result;
  try {
    result = await runClang(
      ['clang++', ...COMPILE_FLAGS, '-Xclang', '-fno-pch-timestamp', '-x', 'c++-header', PRELUDE, '-o', PCH],
      { [PRELUDE]: files.prelude, include: { bits: { 'stdc++.h': files.stdcpp } } },
      {
        stdout: (b) => b && stderr.push(Buffer.from(b)),
        stderr: (b) => b && stderr.push(Buffer.from(b)),
        fetchProgress: () => {},
        decodeASCII: false,
      },
    );
  } catch (err) {
    throw new Error(`Precompiling prelude.h failed:\n${Buffer.concat(stderr).toString()}`);
  }
  await mkdir(CACHE, { recursive: true });
  for (const f of await readdir(CACHE)) {
    if (f.startsWith('prelude-') && f.endsWith('.pch')) await rm(join(CACHE, f));
  }
  await writeFile(out, result[PCH]);
  return out;
}

// Registry of local toolchains. To add a language, create
// src/languages/<id>/worker.js implementing the worker protocol described in
// src/runner/runner.js and register it here.

export const LANGUAGES = [
  {
    id: 'python',
    name: 'Python',
    // LeetCode language slugs this toolchain can run. "python" is LeetCode's
    // Python 2 option; we run it on Python 3, which covers nearly all solutions.
    leetcodeLangs: ['python3', 'python'],
    worker: new URL('./python/worker.js', import.meta.url),
  },
  {
    id: 'cpp',
    name: 'C++',
    leetcodeLangs: ['cpp'],
    worker: new URL('./cpp/worker.js', import.meta.url),
  },
];

export function languageFor(leetcodeLang) {
  return LANGUAGES.find((l) => l.leetcodeLangs.includes(leetcodeLang)) ?? null;
}

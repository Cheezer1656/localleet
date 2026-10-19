// Compare a local output against an expected output (both LeetCode-formatted).
(() => {
  const LL = (globalThis.LocalLeet ??= {});
  const EPS = 1e-5;

  function parse(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return { ok: false };
    }
  }

  function equal(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= EPS;
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && a.every((x, i) => equal(x, b[i]));
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      const ka = Object.keys(a);
      return ka.length === Object.keys(b).length && ka.every((k) => equal(a[k], b[k]));
    }
    return a === b;
  }

  // Canonical form that ignores ordering at every array level.
  function canonical(v) {
    if (Array.isArray(v)) return '[' + v.map(canonical).sort().join(',') + ']';
    return JSON.stringify(v);
  }

  // Returns 'match', 'match-any-order', 'mismatch', or null if unknown.
  function compare(actual, expected, { anyOrder = false } = {}) {
    if (actual == null || expected == null || expected === '') return null;
    const a = parse(actual);
    const e = parse(expected);
    if (!a.ok || !e.ok) {
      return actual.replace(/\s+/g, '') === expected.replace(/\s+/g, '') ? 'match' : 'mismatch';
    }
    if (equal(a.value, e.value)) return 'match';
    if (anyOrder && Array.isArray(a.value) && Array.isArray(e.value)) {
      if (canonical(a.value) === canonical(e.value)) return 'match-any-order';
    }
    return 'mismatch';
  }

  LL.compare = compare;
})();

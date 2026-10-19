// Tests that expected outputs from LeetCode's own Run and Submit are picked up
// by page-bridge.js and saved by harvest.js. The scripts run in a VM context
// with a fake page, fake LeetCode endpoints and an in-memory storage.local.
//
//   node --test tests/harvest.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = (path) => readFileSync(new URL(`../src/content/${path}`, import.meta.url), 'utf8');

const TWO_SUM_META = {
  name: 'twoSum',
  params: [
    { name: 'nums', type: 'integer[]' },
    { name: 'target', type: 'integer' },
  ],
  return: { type: 'integer[]' },
};

function setup(routes) {
  const store = {};
  const changeListeners = [];
  const storage = {
    local: {
      async get(key) {
        if (key == null) return structuredClone(store);
        const keys = typeof key === 'string' ? [key] : Object.keys(key);
        return Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
      },
      async set(items) {
        const changes = {};
        for (const [k, v] of Object.entries(items)) {
          changes[k] = { oldValue: store[k], newValue: v };
          store[k] = structuredClone(v);
        }
        changeListeners.forEach((fn) => fn(changes, 'local'));
      },
    },
    onChanged: { addListener: (fn) => changeListeners.push(fn) },
  };

  const target = new EventTarget();
  const window = {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    postMessage(data) {
      setTimeout(() => {
        const event = new Event('message');
        Object.assign(event, { data, source: window });
        target.dispatchEvent(event);
      });
    },
    async fetch(input, init) {
      const url = new URL(input instanceof Request ? input.url : input, 'https://leetcode.com');
      const route = routes[url.pathname];
      if (!route) return new Response('not found', { status: 404 });
      const body = input instanceof Request ? await input.text() : init?.body;
      return Response.json(typeof route === 'function' ? route(body) : route);
    },
  };
  const location = new URL('https://leetcode.com/problems/two-sum/');
  const ctx = vm.createContext({
    window,
    location,
    document: { querySelector: () => null },
    chrome: { storage },
    Request,
    Response,
    URL,
    setTimeout,
    clearTimeout,
    console,
  });
  for (const file of ['page-bridge.js', 'leetcode.js']) vm.runInContext(src(file), ctx, { filename: file });
  // Avoid the GraphQL request (and DOMParser) for the problem's metadata.
  ctx.LocalLeet.leetcode.fetchProblem = async () => ({ meta: TWO_SUM_META });
  vm.runInContext(src('harvest.js'), ctx, { filename: 'harvest.js' });
  return { ctx, store, page: window, LL: ctx.LocalLeet };
}

// Values from the VM context have its prototypes; compare them as plain data.
const plain = (v) => JSON.parse(JSON.stringify(v ?? null));
const settle = () => new Promise((r) => setTimeout(r, 20));

test('saves expected outputs from a LeetCode Run', async () => {
  const dataInput = '[2,7,11,15]\n9\n[3,2,4]\n6';
  let sentInput = null;
  const { page, LL } = setup({
    '/problems/two-sum/interpret_solution/': (body) => {
      sentInput = JSON.parse(body).data_input;
      return { interpret_id: 'run-1', test_case: dataInput };
    },
    '/submissions/detail/run-1/check/': {
      state: 'SUCCESS',
      code_answer: ['[]', '[]'],
      expected_code_answer: ['[0,1]', '[1,2]', ''],
    },
  });

  await page.fetch('/problems/two-sum/interpret_solution/', {
    method: 'POST',
    body: JSON.stringify({ lang: 'python3', data_input: dataInput, typed_code: '' }),
  });
  await page.fetch('/submissions/detail/run-1/check/');
  await settle();

  assert.equal(sentInput, dataInput);
  const saved = await LL.harvest.expectedOutputs('two-sum');
  assert.deepEqual(plain(saved.get(LL.leetcode.caseKey(['[2,7,11,15]', '9']))), { output: '[0,1]', source: 'run' });
  assert.deepEqual(plain(saved.get(LL.leetcode.caseKey(['[3,2,4]', '6']))), { output: '[1,2]', source: 'run' });
  assert.deepEqual(plain(await LL.harvest.failedCases('two-sum')), []);
});

test('ignores polls that are still pending and runs without expected answers', async () => {
  const { page, store } = setup({
    '/problems/two-sum/interpret_solution/': { interpret_id: 'run-2' },
    '/submissions/detail/run-2/check/': { state: 'STARTED' },
  });
  await page.fetch(
    new Request('https://leetcode.com/problems/two-sum/interpret_solution/', {
      method: 'POST',
      body: JSON.stringify({ data_input: '[1,2]\n3' }),
    }),
  );
  await page.fetch('/submissions/detail/run-2/check/');
  await settle();
  assert.deepEqual(store, {});
});

test('saves the failing testcase of a submission and lists it', async () => {
  const { page, LL } = setup({
    '/problems/two-sum/submit/': { submission_id: 42 },
    '/submissions/detail/42/check/': {
      state: 'SUCCESS',
      status_msg: 'Wrong Answer',
      last_testcase: '[3,3]\n6',
      expected_output: '[0,1]',
      code_output: '[]',
    },
  });
  await page.fetch('/problems/two-sum/submit/', { method: 'POST', body: '{}' });
  await page.fetch('/submissions/detail/42/check/');
  await settle();

  const failed = await LL.harvest.failedCases('two-sum');
  assert.equal(failed.length, 1);
  assert.deepEqual(plain(failed[0].lines), ['[3,3]', '6']);
  assert.equal(failed[0].output, '[0,1]');
  assert.equal(failed[0].submission, 'Wrong Answer');

  await LL.harvest.dismiss('two-sum', ['[3,3]', '6']);
  assert.deepEqual(plain(await LL.harvest.failedCases('two-sum')), []);
  const saved = await LL.harvest.expectedOutputs('two-sum');
  assert.equal(saved.get(LL.leetcode.caseKey(['[3,3]', '6'])).output, '[0,1]');
});

test('accepted submissions save nothing', async () => {
  const { page, store } = setup({
    '/problems/two-sum/submit/': { submission_id: 7 },
    '/submissions/detail/7/check/': { state: 'SUCCESS', status_msg: 'Accepted' },
  });
  await page.fetch('/problems/two-sum/submit/', { method: 'POST', body: '{}' });
  await page.fetch('/submissions/detail/7/check/');
  await settle();
  assert.deepEqual(store, {});
});

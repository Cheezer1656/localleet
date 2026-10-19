// Tests for the C++ toolchain (codegen, prelude harness, WASI runner), using
// the same WebAssembly Clang and precompiled prelude as the extension.
// Run with: node --test tests/

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runClang } from '@yowasp/clang';
import { buildPch, preludeFiles } from '../scripts/cpp-pch.mjs';
import { createToolchain } from '../src/languages/cpp/toolchain.js';

let toolchain;

before(async () => {
  await runClang(null, {}, { fetchProgress: () => {} });
  const pch = await readFile(await buildPch());
  toolchain = createToolchain(runClang, { ...(await preludeFiles()), pch });
});

async function run(code, meta, cases, slug = null) {
  const results = [];
  const out = await toolchain.run({ code, meta, slug, cases }, (i, r) => (results[i] = r));
  return { ...out, results };
}

const outputs = (r) => r.results.map((x) => x.output);

test('two sum with stdout', async () => {
  const code = `
class Solution {
public:
    vector<int> twoSum(vector<int>& nums, int target) {
        unordered_map<int, int> seen;
        for (int i = 0; i < nums.size(); i++) {
            if (seen.count(target - nums[i])) {
                cout << "found " << i << endl;
                return {seen[target - nums[i]], i};
            }
            seen[nums[i]] = i;
        }
        return {};
    }
};`;
  const meta = {
    name: 'twoSum',
    params: [{ name: 'nums', type: 'integer[]' }, { name: 'target', type: 'integer' }],
    return: { type: 'integer[]' },
  };
  const r = await run(code, meta, [['[2,7,11,15]', '9'], ['[3,3]', '6']]);
  assert.deepEqual(outputs(r), ['[0,1]', '[0,1]']);
  assert.equal(r.results[0].stdout, 'found 1\n');
  assert.equal(r.results[0].status, 'ok');
});

test('linked lists', async () => {
  const code = `
#include <bits/stdc++.h>
class Solution {
public:
    ListNode* addTwoNumbers(ListNode* l1, ListNode* l2) {
        ListNode dummy; ListNode* cur = &dummy; int carry = 0;
        while (l1 || l2 || carry) {
            int s = carry + (l1 ? l1->val : 0) + (l2 ? l2->val : 0);
            carry = s / 10; cur = cur->next = new ListNode(s % 10);
            if (l1) l1 = l1->next; if (l2) l2 = l2->next;
        }
        return dummy.next;
    }
};`;
  const meta = {
    name: 'addTwoNumbers',
    params: [{ name: 'l1', type: 'ListNode' }, { name: 'l2', type: 'ListNode' }],
    return: { type: 'ListNode' },
  };
  const r = await run(code, meta, [['[2,4,3]', '[5,6,4]'], ['[9,9,9,9,9,9,9]', '[9,9,9,9]']]);
  assert.deepEqual(outputs(r), ['[7,0,8]', '[8,9,9,9,0,0,0,1]']);
});

test('tree roundtrip', async () => {
  const code = `
class Solution {
public:
    TreeNode* invertTree(TreeNode* root) {
        if (root) { auto l = invertTree(root->right); root->right = invertTree(root->left); root->left = l; }
        return root;
    }
};`;
  const meta = { name: 'invertTree', params: [{ name: 'root', type: 'TreeNode' }], return: { type: 'TreeNode' } };
  const r = await run(code, meta, [['[4,2,7,1,3,6,9]'], ['[]'], ['[1,null,2]']]);
  assert.deepEqual(outputs(r), ['[4,7,2,9,6,3,1]', '[]', '[1,2]']);
});

test('void in place', async () => {
  const code = `
class Solution {
public:
    void rotate(vector<vector<int>>& m) {
        int n = m.size();
        for (int i = 0; i < n; i++) for (int j = i + 1; j < n; j++) swap(m[i][j], m[j][i]);
        for (auto& row : m) reverse(row.begin(), row.end());
    }
};`;
  const meta = {
    name: 'rotate',
    params: [{ name: 'matrix', type: 'integer[][]' }],
    return: { type: 'void' },
    output: { paramindex: 0 },
  };
  const r = await run(code, meta, [['[[1,2,3],[4,5,6],[7,8,9]]']]);
  assert.equal(r.results[0].output, '[[7,4,1],[8,5,2],[9,6,3]]');
});

test('design problem', async () => {
  const code = `
class LRUCache {
    int cap; list<pair<int,int>> order; unordered_map<int, list<pair<int,int>>::iterator> pos;
public:
    LRUCache(int capacity) : cap(capacity) {}
    int get(int key) {
        auto it = pos.find(key);
        if (it == pos.end()) return -1;
        order.splice(order.begin(), order, it->second);
        return it->second->second;
    }
    void put(int key, int value) {
        if (get(key) != -1) { order.front().second = value; return; }
        order.emplace_front(key, value); pos[key] = order.begin();
        if (order.size() > cap) { pos.erase(order.back().first); order.pop_back(); }
    }
};`;
  const meta = {
    classname: 'LRUCache',
    systemdesign: true,
    constructor: { params: [{ type: 'integer', name: 'capacity' }] },
    methods: [
      { name: 'get', params: [{ type: 'integer', name: 'key' }], return: { type: 'integer' } },
      {
        name: 'put',
        params: [{ type: 'integer', name: 'key' }, { type: 'integer', name: 'value' }],
        return: { type: 'void' },
      },
    ],
  };
  const r = await run(code, meta, [
    [
      '["LRUCache","put","put","get","put","get","put","get","get","get"]',
      '[[2],[1,1],[2,2],[1],[3,3],[2],[4,4],[1],[3],[4]]',
    ],
  ]);
  assert.equal(r.results[0].output, '[null,null,null,1,null,-1,null,-1,3,4]');
});

test('doubles, strings, chars and bools', async () => {
  const code = `
class Solution {
public:
    double myPow(double x, int n) { return pow(x, n); }
    vector<string> label(string s) { string u = s; for (auto& c : u) c = toupper(c); return {s, u, "q\\"\\n"}; }
    vector<char> chars(string s) { return vector<char>(s.begin(), s.end()); }
    vector<bool> flags(vector<int>& v) { vector<bool> r; for (int x : v) r.push_back(x % 2); return r; }
    long long big(long long x) { return x * 2; }
};`;
  let meta = {
    name: 'myPow',
    params: [{ name: 'x', type: 'double' }, { name: 'n', type: 'integer' }],
    return: { type: 'double' },
  };
  let r = await run(code, meta, [['2.00000', '10'], ['2.00000', '-2']]);
  assert.deepEqual(outputs(r), ['1024.00000', '0.25000']);
  meta = { name: 'label', params: [{ name: 's', type: 'string' }], return: { type: 'list<string>' } };
  r = await run(code, meta, [['"héllo"']]);
  assert.equal(r.results[0].output, '["héllo","HéLLO","q\\"\\n"]');
  meta = { name: 'chars', params: [{ name: 's', type: 'string' }], return: { type: 'character[]' } };
  r = await run(code, meta, [['"ab"']]);
  assert.equal(r.results[0].output, '["a","b"]');
  meta = { name: 'flags', params: [{ name: 'v', type: 'integer[]' }], return: { type: 'boolean[]' } };
  r = await run(code, meta, [['[1,2]']]);
  assert.equal(r.results[0].output, '[true,false]');
  meta = { name: 'big', params: [{ name: 'x', type: 'long' }], return: { type: 'long' } };
  r = await run(code, meta, [['4000000000000']]);
  assert.equal(r.results[0].output, '8000000000000');
});

test('compile errors use LeetCode line numbers', async () => {
  const code = 'class Solution {\npublic:\n    int f(int n) {\n        return m;\n    }\n};';
  const meta = { name: 'f', params: [{ name: 'n', type: 'integer' }], return: { type: 'integer' } };
  const r = await run(code, meta, [['1']]);
  assert.match(r.compileError, /^Line 4: Char 16: error: use of undeclared identifier 'm'/);
  assert.deepEqual(r.results, []);
});

const intMeta = { name: 'f', params: [{ name: 'n', type: 'integer' }], return: { type: 'integer' } };

test('signed overflow is reported with its line, and later cases still run', async () => {
  const code = 'class Solution {\npublic:\n    int f(int n) {\n        return n + 1;\n    }\n};';
  const r = await run(code, intMeta, [['2147483647'], ['1']]);
  assert.equal(r.results[0].status, 'runtime_error');
  assert.equal(
    r.results[0].error,
    "Line 4: Char 18: runtime error: signed integer overflow: 2147483647 + 1 cannot be represented in type 'int' (solution.cpp)",
  );
  assert.equal(r.results[1].output, '2');
});

test('null member access', async () => {
  const code = 'class Solution {\npublic:\n    int f(int n) {\n        TreeNode* t = nullptr;\n        return t->val;\n    }\n};';
  const r = await run(code, intMeta, [['1']]);
  assert.match(r.results[0].error, /^Line 5: Char \d+: runtime error: member access within null pointer of type 'TreeNode'/);
});

test('vector out of bounds, uncaught exceptions, division by zero', async () => {
  const code = `class Solution {
public:
    int f(int n) {
        vector<int> v(3);
        if (n == 0) return v[n + 5];
        if (n == 1) throw invalid_argument("bad n");
        if (n == 2) return 10 / (n - 2);
        if (n == 3) return v.at(7);
        return n;
    }
};`;
  const r = await run(code, intMeta, [['0'], ['1'], ['2'], ['3'], ['4']]);
  assert.deepEqual(
    r.results.map((x) => x.status),
    ['runtime_error', 'runtime_error', 'runtime_error', 'runtime_error', 'ok'],
  );
  assert.match(r.results[0].error, /vector\[\] index out of bounds/);
  assert.equal(
    r.results[1].error,
    "terminate called after throwing an instance of 'std::invalid_argument'\n  what():  bad n",
  );
  assert.match(r.results[2].error, /^Line 7: .*division by zero/);
  assert.match(r.results[3].error, /out_of_range|vector/);
  assert.equal(r.results[4].output, '4');
});

test('stack overflow', async () => {
  const code = 'class Solution {\npublic:\n    int f(int n) { volatile char pad[64]; pad[0] = n; return f(n + 1) + pad[0]; }\n};';
  const r = await run(code, intMeta, [['1'], ['2']]);
  assert.equal(r.results[0].status, 'runtime_error');
  assert.match(r.results[0].error, /stack overflow/);
  assert.equal(r.results[1].status, 'runtime_error');
});

test('long overflow mentions the 32-bit long', async () => {
  const code = 'class Solution {\npublic:\n    int f(int n) {\n        long x = n;\n        return x * x > 0;\n    }\n};';
  const r = await run(code, intMeta, [['100000']]);
  assert.match(r.results[0].error, /type 'long'.*\nNote: `long` is 32 bits/s);
});

test('linked list cycle', async () => {
  const code = `class Solution {
public:
    bool hasCycle(ListNode *head) {
        ListNode *slow = head, *fast = head;
        while (fast && fast->next) { slow = slow->next; fast = fast->next->next; if (slow == fast) return true; }
        return false;
    }
};`;
  const meta = {
    name: 'hasCycle',
    params: [{ name: 'head', type: 'ListNode' }, { name: 'pos', type: 'integer' }],
    return: { type: 'boolean' },
    manual: true,
  };
  const r = await run(code, meta, [['[3,2,0,-4]', '1'], ['[1]', '-1']], 'linked-list-cycle');
  assert.deepEqual(outputs(r), ['true', 'false']);
});

test('lowest common ancestor', async () => {
  const code = `class Solution {
public:
    TreeNode* lowestCommonAncestor(TreeNode* root, TreeNode* p, TreeNode* q) {
        if (!root || root == p || root == q) return root;
        auto l = lowestCommonAncestor(root->left, p, q), r = lowestCommonAncestor(root->right, p, q);
        return l && r ? root : l ? l : r;
    }
};`;
  const meta = {
    name: 'lowestCommonAncestor',
    params: [{ name: 'root', type: 'TreeNode' }, { name: 'p', type: 'integer' }, { name: 'q', type: 'integer' }],
    return: { type: 'TreeNode' },
    manual: true,
  };
  const r = await run(code, meta, [['[3,5,1,6,2,0,8,null,null,7,4]', '5', '4']], 'lowest-common-ancestor-of-a-binary-tree');
  assert.equal(r.results[0].output, '5');
});

test('intersection of two lists', async () => {
  const code = `class Solution {
public:
    ListNode *getIntersectionNode(ListNode *a, ListNode *b) {
        ListNode *x = a, *y = b;
        while (x != y) { x = x ? x->next : b; y = y ? y->next : a; }
        return x;
    }
};`;
  const meta = { name: 'getIntersectionNode', params: [], manual: true };
  const r = await run(
    code,
    meta,
    [['8', '[4,1,8,4,5]', '[5,6,1,8,4,5]', '2', '3'], ['0', '[2,6,4]', '[1,5]', '3', '2']],
    'intersection-of-two-linked-lists',
  );
  assert.deepEqual(outputs(r), ["Intersected at '8'", 'No intersection']);
});

test('clone graph', async () => {
  const code = `class Solution {
    unordered_map<Node*, Node*> memo;
public:
    Node* cloneGraph(Node* node) {
        if (!node) return nullptr;
        if (memo.count(node)) return memo[node];
        Node* c = memo[node] = new Node(node->val);
        for (Node* n : node->neighbors) c->neighbors.push_back(cloneGraph(n));
        return c;
    }
};`;
  const meta = { name: 'cloneGraph', params: [{ name: 'edges', type: 'integer[][]' }], manual: true };
  const r = await run(code, meta, [['[[2,4],[1,3],[2,4],[1,3]]'], ['[]']], 'clone-graph');
  assert.deepEqual(outputs(r), ['[[2,4],[1,3],[2,4],[1,3]]', '[]']);
});

test('bad input is a harness error', async () => {
  const code = 'class Solution { public: int f(int n) { return n; } };';
  const r = await run(code, intMeta, [['[1,'], ['"x"'], ['5']]);
  assert.deepEqual(
    r.results.map((x) => x.status),
    ['harness_error', 'harness_error', 'ok'],
  );
  assert.match(r.results[1].error, /Expected an integer, got "x"/);
});

test('unsupported parameter types are reported per case', async () => {
  const meta = { name: 'f', params: [{ name: 'n', type: 'NestedInteger' }], return: { type: 'integer' } };
  const r = await run('class Solution {};', meta, [['[1]']]);
  assert.equal(r.results[0].status, 'harness_error');
  assert.match(r.results[0].error, /NestedInteger/);
});

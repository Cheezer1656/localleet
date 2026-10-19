// Generates the C++ glue between the prelude's harness and a submission:
// for each testcase, convert the parsed JSON lines into the declared C++
// argument types, call the Solution (or design class) and serialize the result.
// Conversion and output formatting are overloads in prelude.h, so the glue
// only needs the C++ type of each parameter.

export class UnsupportedProblem extends Error {}

// LeetCode metaData type -> C++ type.
export function cppType(t) {
  const type = (t ?? '').trim();
  if (type.endsWith('[]')) return `vector<${cppType(type.slice(0, -2))}>`;
  const lower = type.toLowerCase();
  if (lower.startsWith('list<') && type.endsWith('>')) return `vector<${cppType(type.slice(5, -1))}>`;
  switch (lower) {
    case 'integer':
    case 'int':
      return 'int';
    case 'long':
      return 'long long';
    case 'double':
    case 'float':
      return 'double';
    case 'boolean':
    case 'bool':
      return 'bool';
    case 'character':
    case 'char':
      return 'char';
    case 'string':
      return 'string';
    case 'listnode':
      return 'ListNode*';
    case 'treenode':
      return 'TreeNode*';
    case 'void':
      return 'void';
  }
  throw new UnsupportedProblem(`LocalLeet's C++ harness doesn't support the type "${type}" yet.`);
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(name, what) {
  if (!IDENT.test(name ?? '')) throw new UnsupportedProblem(`Unexpected ${what} name "${name}" in the problem metadata.`);
  return name;
}

// Declarations converting `list` (a __ll::Value array) into p0, p1, ...
function convertArgs(params, list, indent) {
  return params
    .map((p, k) => `${indent}auto p${k} = __ll::arg<${cppType(p.type)}>(${list}, ${k});`)
    .join('\n');
}

function argNames(params) {
  return params.map((_, k) => `p${k}`).join(', ');
}

// Problems marked "manual" in metaData use custom judges on LeetCode. These
// mirror the adapters in the Python harness.
const SPECIAL_CASES = {
  'linked-list-cycle': (m) => `return __ll::has_cycle([&](ListNode* h) { return sol->${m}(h); }, in);`,
  'linked-list-cycle-ii': (m) => `return __ll::detect_cycle([&](ListNode* h) { return sol->${m}(h); }, in);`,
  'intersection-of-two-linked-lists': (m) =>
    `return __ll::intersection([&](ListNode* a, ListNode* b) { return sol->${m}(a, b); }, in);`,
  'lowest-common-ancestor-of-a-binary-tree': (m) =>
    `return __ll::lowest_common_ancestor([&](TreeNode* r, TreeNode* p, TreeNode* q) { return sol->${m}(r, p, q); }, in);`,
  'lowest-common-ancestor-of-a-binary-search-tree': (m) =>
    `return __ll::lowest_common_ancestor([&](TreeNode* r, TreeNode* p, TreeNode* q) { return sol->${m}(r, p, q); }, in);`,
  'clone-graph': (m) => `return __ll::clone_graph<Node>([&](Node* n) { return sol->${m}(n); }, in);`,
};

// Types LeetCode's judge defines for particular problems (their templates
// show them commented out).
const EXTRA_DEFINITIONS = {
  'clone-graph': `class Node {
public:
    int val;
    vector<Node*> neighbors;
    Node() { val = 0; neighbors = vector<Node*>(); }
    Node(int _val) { val = _val; neighbors = vector<Node*>(); }
    Node(int _val, vector<Node*> _neighbors) { val = _val; neighbors = _neighbors; }
};`,
};

function functionGlue(meta, slug) {
  const name = ident(meta.name, 'method');
  const special = SPECIAL_CASES[slug];
  if (special) {
    return `  Solution* sol = new Solution();\n  ${special(name)}`;
  }
  const params = meta.params ?? [];
  const lines = [
    `  const __ll::Value list{__ll::Value::Arr, false, {}, in};`,
    convertArgs(params, 'list', '  '),
    `  Solution* sol = new Solution();`,
  ];
  const retType = meta.return?.type;
  const output = meta.output ?? {};
  if (retType === 'void' || 'paramindex' in output) {
    const idx = output.paramindex ?? 0;
    if (!params[idx]) throw new UnsupportedProblem('The problem metadata has no parameter to print.');
    lines.push(`  sol->${name}(${argNames(params)});`, `  return __ll::to_json(p${idx});`);
  } else {
    lines.push(`  return __ll::to_json(sol->${name}(${argNames(params)}));`);
  }
  return lines.filter(Boolean).join('\n');
}

function designGlue(meta) {
  const cls = ident(meta.classname, 'class');
  const ctor = meta.constructor?.params ?? [];
  const branches = (meta.methods ?? []).map((m) => {
    const name = ident(m.name, 'method');
    const params = m.params ?? [];
    const call = `obj->${name}(${argNames(params)})`;
    const body = [
      convertArgs(params, 'args.a[i]', '      '),
      m.return?.type === 'void' || !m.return?.type
        ? `      ${call};\n      out += "null";`
        : `      out += __ll::to_json(${call});`,
    ];
    return `    } else if (name == "${name}") {\n${body.filter(Boolean).join('\n')}`;
  });
  return `  if (in.size() < 2) __ll::harness_error("Design problems need two lines: method names and arguments");
  const __ll::Value& names = in[0];
  const __ll::Value& args = in[1];
  if (names.kind != __ll::Value::Arr || args.kind != __ll::Value::Arr)
    __ll::harness_error("Design problem lines must be arrays");
  if (names.a.size() != args.a.size()) __ll::harness_error("Method names and argument lists differ in length");
  string out = "[";
  ${cls}* obj = nullptr;
  for (size_t i = 0; i < names.a.size(); i++) {
    if (i) out += ",";
    if (names.a[i].kind != __ll::Value::Str) __ll::harness_error("Method names must be strings");
    const string& name = names.a[i].s;
    if (i == 0) {
${convertArgs(ctor, 'args.a[i]', '      ')}
      obj = new ${cls}(${argNames(ctor)});
      out += "null";
${branches.join('\n')}
    } else {
      __ll::harness_error("${cls} has no method \`" + name + "\`");
    }
  }
  return out + "]";`;
}

// Returns the full translation unit. The prelude is force-included (from the
// PCH), so it isn't part of the source. The user's code is preceded by
// `#line 1 "solution.cpp"` so diagnostics and sanitizer reports point at
// their own line numbers.
export function generateSource(code, meta, slug) {
  const glue = meta.systemdesign ? designGlue(meta) : functionGlue(meta, slug);
  return [
    EXTRA_DEFINITIONS[slug] ?? '',
    '#line 1 "solution.cpp"',
    code,
    '',
    '#line 1 "localleet_main.cpp"',
    'static string __ll_run(const vector<__ll::Value>& in) {',
    glue,
    '}',
    'int main(int argc, char** argv) { return __ll::main(argc, argv, __ll_run); }',
    '',
  ].join('\n');
}

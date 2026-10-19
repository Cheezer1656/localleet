// LocalLeet C++ prelude. Precompiled at build time (scripts/build.mjs) and
// force-included before every submission, mirroring what LeetCode's judge
// puts around your code: the whole standard library, `using namespace std`,
// ListNode/TreeNode, plus the harness that parses testcases and prints
// results. Everything harness-specific lives in namespace __ll.

#pragma once

// ---------------------------------------------------------------- headers
// The equivalent of <bits/stdc++.h> (which libc++ doesn't have).
#include <algorithm>
#include <any>
#include <array>
#include <bit>
#include <bitset>
#include <cassert>
#include <cctype>
#include <cfloat>
#include <charconv>
#include <chrono>
#include <climits>
#include <cmath>
#include <compare>
#include <complex>
#include <concepts>
#include <cstdarg>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <deque>
#include <exception>
#include <expected>
#include <forward_list>
#include <functional>
#include <initializer_list>
#include <iomanip>
#include <ios>
#include <iostream>
#include <istream>
#include <iterator>
#include <limits>
#include <list>
#include <map>
#include <memory>
#include <numbers>
#include <numeric>
#include <optional>
#include <ostream>
#include <queue>
#include <random>
#include <ranges>
#include <ratio>
#include <regex>
#include <set>
#include <span>
#include <sstream>
#include <stack>
#include <stdexcept>
#include <string>
#include <string_view>
#include <tuple>
#include <type_traits>
#include <typeinfo>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <valarray>
#include <variant>
#include <vector>
#include <unistd.h>

using namespace std;

// ---------------------------------------------------------------- LeetCode types

struct ListNode {
  int val;
  ListNode *next;
  ListNode() : val(0), next(nullptr) {}
  ListNode(int x) : val(x), next(nullptr) {}
  ListNode(int x, ListNode *next) : val(x), next(next) {}
};

struct TreeNode {
  int val;
  TreeNode *left;
  TreeNode *right;
  TreeNode() : val(0), left(nullptr), right(nullptr) {}
  TreeNode(int x) : val(x), left(nullptr), right(nullptr) {}
  TreeNode(int x, TreeNode *left, TreeNode *right) : val(x), left(left), right(right) {}
};

// ---------------------------------------------------------------- harness

// The harness reports to the host over file descriptor 3, one line per frame:
//   B <index>      a testcase starts
//   R <json>       it returned; <json> is the serialized output as a JSON string
//   H <json>       the testcase input doesn't fit the problem (harness error)
//   E <json>       runtime error message; the program traps right after
// The host re-instantiates the module after a trap and continues with the next
// testcase, so a crash only affects the case it happened in.
namespace __ll {

using std::string;
using std::string_view;
using std::vector;

inline void flush_user_output() {
  std::cout.flush();
  std::cerr.flush();
  fflush(stdout);
  fflush(stderr);
}

inline void write_all(int fd, const string &s) {
  const char *p = s.data();
  size_t n = s.size();
  while (n) {
    ssize_t w = ::write(fd, p, n);
    if (w <= 0) return;
    p += w;
    n -= size_t(w);
  }
}

inline void escape_into(string &o, string_view s) {
  o += '"';
  for (unsigned char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      case '\b': o += "\\b"; break;
      case '\f': o += "\\f"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          snprintf(buf, sizeof buf, "\\u%04x", c);
          o += buf;
        } else {
          o += char(c);
        }
    }
  }
  o += '"';
}

inline void frame(char tag, string_view payload, bool json) {
  flush_user_output();
  string line(1, tag);
  line += ' ';
  if (json) escape_into(line, payload);
  else line += payload;
  line += '\n';
  write_all(3, line);
}

[[noreturn]] inline void runtime_error(string_view msg) {
  frame('E', msg, true);
  __builtin_trap();
}

[[noreturn]] inline void harness_error(string_view msg) {
  frame('H', msg, true);
  __builtin_trap();
}

// ---- JSON values (testcase lines)

struct Value {
  enum Kind { Null, Bool, Num, Str, Arr, Obj } kind = Null;
  bool b = false;
  string s;  // number text or string contents
  vector<Value> a;
};

string dump(const Value &v);

struct Parser {
  string_view in;
  size_t i = 0;
  string err;

  void ws() {
    while (i < in.size() && (in[i] == ' ' || in[i] == '\t' || in[i] == '\n' || in[i] == '\r')) i++;
  }
  bool fail(const char *what) {
    if (err.empty()) err = what;
    return false;
  }
  static void utf8(string &o, unsigned cp) {
    if (cp < 0x80) {
      o += char(cp);
    } else if (cp < 0x800) {
      o += char(0xC0 | (cp >> 6));
      o += char(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
      o += char(0xE0 | (cp >> 12));
      o += char(0x80 | ((cp >> 6) & 0x3F));
      o += char(0x80 | (cp & 0x3F));
    } else {
      o += char(0xF0 | (cp >> 18));
      o += char(0x80 | ((cp >> 12) & 0x3F));
      o += char(0x80 | ((cp >> 6) & 0x3F));
      o += char(0x80 | (cp & 0x3F));
    }
  }
  bool hex4(unsigned &cp) {
    if (i + 4 > in.size()) return fail("bad \\u escape");
    cp = 0;
    for (int k = 0; k < 4; k++) {
      char c = in[i++];
      cp <<= 4;
      if (c >= '0' && c <= '9') cp |= unsigned(c - '0');
      else if (c >= 'a' && c <= 'f') cp |= unsigned(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') cp |= unsigned(c - 'A' + 10);
      else return fail("bad \\u escape");
    }
    return true;
  }
  bool str(string &o) {
    i++;  // opening quote
    while (i < in.size()) {
      char c = in[i++];
      if (c == '"') return true;
      if (c != '\\') {
        o += c;
        continue;
      }
      if (i >= in.size()) break;
      char e = in[i++];
      switch (e) {
        case '"': o += '"'; break;
        case '\\': o += '\\'; break;
        case '/': o += '/'; break;
        case 'b': o += '\b'; break;
        case 'f': o += '\f'; break;
        case 'n': o += '\n'; break;
        case 'r': o += '\r'; break;
        case 't': o += '\t'; break;
        case 'u': {
          unsigned cp;
          if (!hex4(cp)) return false;
          if (cp >= 0xD800 && cp < 0xDC00 && i + 1 < in.size() && in[i] == '\\' && in[i + 1] == 'u') {
            i += 2;
            unsigned lo;
            if (!hex4(lo)) return false;
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
          }
          utf8(o, cp);
          break;
        }
        default: return fail("bad escape");
      }
    }
    return fail("unterminated string");
  }
  bool value(Value &v, int depth = 0) {
    if (depth > 200) return fail("nested too deeply");
    ws();
    if (i >= in.size()) return fail("unexpected end");
    char c = in[i];
    if (c == '[' || c == '{') {
      bool obj = c == '{';
      v.kind = obj ? Value::Obj : Value::Arr;
      char close = obj ? '}' : ']';
      i++;
      ws();
      if (i < in.size() && in[i] == close) {
        i++;
        return true;
      }
      while (true) {
        if (obj) {
          // Objects are kept as [key, value, key, value, ...].
          ws();
          if (i >= in.size() || in[i] != '"') return fail("expected a key");
          Value key;
          key.kind = Value::Str;
          if (!str(key.s)) return false;
          ws();
          if (i >= in.size() || in[i] != ':') return fail("expected ':'");
          i++;
          v.a.push_back(std::move(key));
        }
        v.a.emplace_back();
        if (!value(v.a.back(), depth + 1)) return false;
        ws();
        if (i < in.size() && in[i] == ',') {
          i++;
          continue;
        }
        if (i < in.size() && in[i] == close) {
          i++;
          return true;
        }
        return fail("expected ',' or a closing bracket");
      }
    }
    if (c == '"') {
      v.kind = Value::Str;
      return str(v.s);
    }
    if (in.substr(i, 4) == "null") {
      i += 4;
      v.kind = Value::Null;
      return true;
    }
    if (in.substr(i, 4) == "true") {
      i += 4;
      v.kind = Value::Bool;
      v.b = true;
      return true;
    }
    if (in.substr(i, 5) == "false") {
      i += 5;
      v.kind = Value::Bool;
      return true;
    }
    size_t start = i;
    if (i < in.size() && (in[i] == '-' || in[i] == '+')) i++;
    while (i < in.size() && (isdigit((unsigned char)in[i]) || in[i] == '.' || in[i] == 'e' ||
                             in[i] == 'E' || in[i] == '-' || in[i] == '+'))
      i++;
    if (i == start) return fail("unexpected character");
    v.kind = Value::Num;
    v.s = string(in.substr(start, i - start));
    return true;
  }
};

inline bool parse(string_view line, Value &out, string &err) {
  Parser p{line};
  if (!p.value(out)) {
    err = p.err;
    return false;
  }
  p.ws();
  if (p.i != line.size()) {
    err = "trailing characters";
    return false;
  }
  return true;
}

inline string dump(const Value &v) {
  string o;
  switch (v.kind) {
    case Value::Null: return "null";
    case Value::Bool: return v.b ? "true" : "false";
    case Value::Num: return v.s;
    case Value::Str: escape_into(o, v.s); return o;
    case Value::Arr:
    case Value::Obj:
      o += v.kind == Value::Arr ? '[' : '{';
      for (size_t k = 0; k < v.a.size(); k++) {
        if (k) o += (v.kind == Value::Obj && k % 2) ? ':' : ',';
        o += dump(v.a[k]);
      }
      o += v.kind == Value::Arr ? ']' : '}';
      return o;
  }
  return o;
}

[[noreturn]] inline void expected(const char *what, const Value &v) {
  string got = dump(v);
  if (got.size() > 200) got = got.substr(0, 200) + "...";
  harness_error(string("Expected ") + what + ", got " + got);
}

// ---- testcase value -> C++ argument

template <class T>
  requires(std::is_integral_v<T> && !std::is_same_v<T, bool> && !std::is_same_v<T, char>)
void from_json(const Value &v, T &out) {
  if (v.kind != Value::Num) expected("an integer", v);
  if (v.s.find_first_of(".eE") != string::npos) {
    out = T(strtod(v.s.c_str(), nullptr));
  } else if (std::is_signed_v<T>) {
    out = T(strtoll(v.s.c_str(), nullptr, 10));
  } else {
    out = T(strtoull(v.s.c_str(), nullptr, 10));
  }
}

inline void from_json(const Value &v, bool &out) {
  if (v.kind == Value::Bool) out = v.b;
  else if (v.kind == Value::Num) out = strtod(v.s.c_str(), nullptr) != 0;
  else expected("a boolean", v);
}

inline void from_json(const Value &v, char &out) {
  if (v.kind != Value::Str || v.s.size() != 1) expected("a single character", v);
  out = v.s[0];
}

inline void from_json(const Value &v, double &out) {
  if (v.kind != Value::Num) expected("a number", v);
  out = strtod(v.s.c_str(), nullptr);
}

inline void from_json(const Value &v, float &out) {
  double d;
  from_json(v, d);
  out = float(d);
}

inline void from_json(const Value &v, string &out) {
  if (v.kind != Value::Str) expected("a string", v);
  out = v.s;
}

template <class T>
void from_json(const Value &v, vector<T> &out) {
  out.clear();
  if (v.kind == Value::Null) return;
  if (v.kind != Value::Arr) expected("an array", v);
  out.reserve(v.a.size());
  for (const Value &e : v.a) {
    T x{};
    from_json(e, x);
    out.push_back(std::move(x));
  }
}

inline vector<int> int_values(const Value &v) {
  vector<int> vals;
  from_json(v, vals);
  return vals;
}

inline ListNode *build_list(const vector<int> &vals) {
  ListNode dummy;
  ListNode *tail = &dummy;
  for (int x : vals) tail = tail->next = new ListNode(x);
  return dummy.next;
}

inline void from_json(const Value &v, ListNode *&out) { out = build_list(int_values(v)); }

inline void from_json(const Value &v, TreeNode *&out) {
  out = nullptr;
  if (v.kind == Value::Null) return;
  if (v.kind != Value::Arr) expected("an array (tree in level order)", v);
  const auto &a = v.a;
  auto make = [&](const Value &e) -> TreeNode * {
    if (e.kind == Value::Null) return nullptr;
    int x;
    from_json(e, x);
    return new TreeNode(x);
  };
  if (a.empty() || a[0].kind == Value::Null) return;
  out = make(a[0]);
  vector<TreeNode *> queue{out};
  size_t i = 1, head = 0;
  while (i < a.size() && head < queue.size()) {
    TreeNode *node = queue[head++];
    if (i < a.size()) {
      node->left = make(a[i++]);
      if (node->left) queue.push_back(node->left);
    }
    if (i < a.size()) {
      node->right = make(a[i++]);
      if (node->right) queue.push_back(node->right);
    }
  }
}

template <class T>
T arg(const Value &list, size_t k) {
  if (list.kind != Value::Arr || k >= list.a.size())
    harness_error("Missing argument " + std::to_string(k + 1) + " in " + dump(list));
  T x{};
  from_json(list.a[k], x);
  return x;
}

// ---- C++ result -> LeetCode output text

inline void ser(string &o, bool v) { o += v ? "true" : "false"; }

inline void ser(string &o, char v) { escape_into(o, string_view(&v, 1)); }

template <class T>
  requires(std::is_integral_v<T> && !std::is_same_v<T, bool> && !std::is_same_v<T, char>)
void ser(string &o, T v) {
  o += std::to_string(v);
}

inline void ser(string &o, double v) {
  if (v != v) {
    o += "NaN";
  } else if (std::isinf(v)) {
    o += v > 0 ? "Infinity" : "-Infinity";
  } else {
    char buf[64];
    snprintf(buf, sizeof buf, "%.5f", v);
    o += buf;
  }
}

inline void ser(string &o, float v) { ser(o, double(v)); }

inline void ser(string &o, const string &v) { escape_into(o, v); }

inline void ser(string &o, const char *v) {
  if (v) escape_into(o, v);
  else o += "null";
}

inline void ser(string &o, ListNode *head) {
  o += '[';
  for (int n = 0; head; head = head->next, n++) {
    if (n > 100000) harness_error("Returned linked list is too long (cycle?)");
    if (n) o += ',';
    o += std::to_string(head->val);
  }
  o += ']';
}

inline void ser(string &o, TreeNode *root) {
  vector<TreeNode *> queue;
  if (root) queue.push_back(root);
  vector<string> out;
  for (size_t head = 0; head < queue.size(); head++) {
    TreeNode *node = queue[head];
    if (!node) {
      out.push_back("null");
      continue;
    }
    if (queue.size() > 2000000) harness_error("Returned tree is too large (cycle?)");
    out.push_back(std::to_string(node->val));
    queue.push_back(node->left);
    queue.push_back(node->right);
  }
  while (!out.empty() && out.back() == "null") out.pop_back();
  o += '[';
  for (size_t k = 0; k < out.size(); k++) {
    if (k) o += ',';
    o += out[k];
  }
  o += ']';
}

template <class T>
void ser(string &o, const vector<T> &v);

template <class A, class B>
void ser(string &o, const std::pair<A, B> &p) {
  o += '[';
  ser(o, p.first);
  o += ',';
  ser(o, p.second);
  o += ']';
}

template <class T>
void ser(string &o, const vector<T> &v) {
  o += '[';
  bool first = true;
  for (auto &&x : v) {
    if (!first) o += ',';
    first = false;
    if constexpr (std::is_same_v<T, bool>) ser(o, bool(x));
    else ser(o, x);
  }
  o += ']';
}

template <class T>
string to_json(const T &v) {
  string o;
  ser(o, v);
  return o;
}

// ---- custom judges (problems marked "manual" in metaData)

struct CycleList {
  ListNode *head = nullptr;
  vector<ListNode *> nodes;
};

inline CycleList list_with_cycle(const vector<Value> &in) {
  CycleList r;
  r.head = build_list(int_values(in.at(0)));
  for (ListNode *n = r.head; n; n = n->next) r.nodes.push_back(n);
  int pos = -1;
  if (in.size() > 1 && in[1].kind == Value::Num) from_json(in[1], pos);
  if (pos >= 0 && size_t(pos) < r.nodes.size()) r.nodes.back()->next = r.nodes[size_t(pos)];
  return r;
}

template <class F>
string has_cycle(F call, const vector<Value> &in) {
  return to_json(bool(call(list_with_cycle(in).head)));
}

template <class F>
string detect_cycle(F call, const vector<Value> &in) {
  CycleList l = list_with_cycle(in);
  ListNode *r = call(l.head);
  if (!r) return "no cycle";
  for (size_t k = 0; k < l.nodes.size(); k++)
    if (l.nodes[k] == r) return "tail connects to node index " + std::to_string(k);
  harness_error("Returned node is not part of the input list");
}

template <class F>
string intersection(F call, const vector<Value> &in) {
  if (in.size() < 5) harness_error("Expected 5 lines: intersectVal, listA, listB, skipA, skipB");
  int intersect, skipA, skipB;
  from_json(in[0], intersect);
  vector<int> a = int_values(in[1]), b = int_values(in[2]);
  from_json(in[3], skipA);
  from_json(in[4], skipB);
  auto attach = [](ListNode *head, ListNode *tail) {
    if (!head) return tail;
    ListNode *n = head;
    while (n->next) n = n->next;
    n->next = tail;
    return head;
  };
  ListNode *ha, *hb;
  if (intersect) {
    skipA = std::clamp(skipA, 0, int(a.size()));
    skipB = std::clamp(skipB, 0, int(b.size()));
    ListNode *shared = build_list(vector<int>(a.begin() + skipA, a.end()));
    ha = attach(build_list(vector<int>(a.begin(), a.begin() + skipA)), shared);
    hb = attach(build_list(vector<int>(b.begin(), b.begin() + skipB)), shared);
  } else {
    ha = build_list(a);
    hb = build_list(b);
  }
  ListNode *r = call(ha, hb);
  if (!r) return "No intersection";
  return "Intersected at '" + std::to_string(r->val) + "'";
}

inline TreeNode *find_tree_node(TreeNode *root, const Value &v) {
  int val;
  from_json(v, val);
  vector<TreeNode *> stack{root};
  while (!stack.empty()) {
    TreeNode *n = stack.back();
    stack.pop_back();
    if (!n) continue;
    if (n->val == val) return n;
    stack.push_back(n->left);
    stack.push_back(n->right);
  }
  harness_error("No node with value " + v.s + " in the tree");
}

template <class F>
string lowest_common_ancestor(F call, const vector<Value> &in) {
  if (in.size() < 3) harness_error("Expected 3 lines: root, p, q");
  TreeNode *root;
  from_json(in[0], root);
  TreeNode *r = call(root, find_tree_node(root, in[1]), find_tree_node(root, in[2]));
  return r ? std::to_string(r->val) : "null";
}

template <class N, class F>
string clone_graph(F call, const vector<Value> &in) {
  vector<vector<int>> adjacency;
  from_json(in.at(0), adjacency);
  vector<N *> nodes;
  for (size_t k = 0; k < adjacency.size(); k++) nodes.push_back(new N(int(k + 1)));
  for (size_t k = 0; k < adjacency.size(); k++)
    for (int n : adjacency[k]) {
      if (n < 1 || size_t(n) > nodes.size()) harness_error("Neighbor index out of range");
      nodes[k]->neighbors.push_back(nodes[size_t(n - 1)]);
    }
  N *r = call(nodes.empty() ? nullptr : nodes[0]);
  if (!r) return "[]";
  std::map<int, N *> seen;
  vector<N *> stack{r};
  while (!stack.empty()) {
    N *n = stack.back();
    stack.pop_back();
    if (seen.count(n->val)) continue;
    if (std::find(nodes.begin(), nodes.end(), n) != nodes.end())
      harness_error("Returned graph shares nodes with the input");
    seen[n->val] = n;
    for (N *m : n->neighbors) stack.push_back(m);
  }
  vector<vector<int>> out;
  for (auto &[val, n] : seen) {
    vector<int> row;
    for (N *m : n->neighbors) row.push_back(m->val);
    out.push_back(row);
  }
  return to_json(out);
}

// ---- main loop

using RunFn = string (*)(const vector<Value> &);

// stdin: <case count>\n then per case <line count>\n<line>\n...
// argv[1]: index of the first case to run (after a trap, the host restarts us).
inline int main(int argc, char **argv, RunFn run) {
  size_t start = argc > 1 ? size_t(strtoul(argv[1], nullptr, 10)) : 0;
  string input;
  char buf[65536];
  size_t n;
  while ((n = fread(buf, 1, sizeof buf, stdin)) > 0) input.append(buf, n);
  vector<string_view> lines;
  for (size_t pos = 0; pos <= input.size();) {
    size_t nl = input.find('\n', pos);
    if (nl == string::npos) nl = input.size();
    lines.push_back(string_view(input).substr(pos, nl - pos));
    pos = nl + 1;
  }
  size_t li = 0;
  auto next_line = [&]() -> string_view { return li < lines.size() ? lines[li++] : string_view(); };
  size_t cases = strtoul(string(next_line()).c_str(), nullptr, 10);
  for (size_t c = 0; c < cases; c++) {
    size_t count = strtoul(string(next_line()).c_str(), nullptr, 10);
    vector<string_view> raw;
    for (size_t k = 0; k < count; k++) raw.push_back(next_line());
    if (c < start) continue;
    frame('B', std::to_string(c), false);
    vector<Value> values(raw.size());
    string err;
    bool ok = true;
    for (size_t k = 0; k < raw.size() && ok; k++) {
      if (!parse(raw[k], values[k], err)) {
        frame('H', "Could not parse testcase line: " + string(raw[k]) + " (" + err + ")", true);
        ok = false;
      }
    }
    if (!ok) continue;
    string out = run(values);
    frame('R', out, true);
  }
  return 0;
}

}  // namespace __ll

// ---------------------------------------------------------------- runtime errors
// Stand-ins for the runtimes LeetCode links against (UBSan, exceptions), which
// the WebAssembly sysroot doesn't ship. Each reports through the E frame.

namespace __ll::ubsan {

struct SourceLocation {
  const char *file;
  uint32_t line;
  uint32_t column;
};
struct TypeDescriptor {
  uint16_t kind;
  uint16_t info;
  char name[1];
};
struct TypeMismatchData {
  SourceLocation loc;
  const TypeDescriptor &type;
  unsigned char log_alignment;
  unsigned char check_kind;
};
struct OverflowData {
  SourceLocation loc;
  const TypeDescriptor &type;
};
struct ShiftData {
  SourceLocation loc;
  const TypeDescriptor &lhs;
  const TypeDescriptor &rhs;
};
struct OutOfBoundsData {
  SourceLocation loc;
  const TypeDescriptor &array;
  const TypeDescriptor &index;
};
struct LocationData {
  SourceLocation loc;
};
struct VlaData {
  SourceLocation loc;
  const TypeDescriptor &type;
};

using Handle = uintptr_t;

inline bool is_signed(const TypeDescriptor &t) { return t.kind == 0 && (t.info & 1); }
inline unsigned bit_width(const TypeDescriptor &t) { return 1u << (t.info >> 1); }

inline long long signed_value(const TypeDescriptor &t, Handle h) {
  unsigned w = bit_width(t);
  if (w > sizeof(Handle) * 8) return *reinterpret_cast<const long long *>(h);
  unsigned extra = sizeof(Handle) * 8 - w;
  return (long long)(intptr_t(h << extra) >> extra);
}

inline unsigned long long unsigned_value(const TypeDescriptor &t, Handle h) {
  if (bit_width(t) > sizeof(Handle) * 8) return *reinterpret_cast<const unsigned long long *>(h);
  return h;
}

inline string value(const TypeDescriptor &t, Handle h) {
  if (t.kind != 0) return "<value>";
  return is_signed(t) ? std::to_string(signed_value(t, h)) : std::to_string(unsigned_value(t, h));
}

[[noreturn]] inline void report(const SourceLocation &loc, const string &msg, const TypeDescriptor *type = nullptr) {
  string out;
  if (loc.file && !strcmp(loc.file, "solution.cpp")) {
    out = "Line " + std::to_string(loc.line) + ": Char " + std::to_string(loc.column) + ": ";
  }
  out += "runtime error: " + msg;
  if (loc.file && !strcmp(loc.file, "solution.cpp")) out += " (solution.cpp)";
  if (type && !strcmp(type->name, "'long'")) {
    out += "\nNote: `long` is 32 bits in LocalLeet's WebAssembly build (it is 64 bits on LeetCode). Use `long long`.";
  }
  runtime_error(out);
}

[[noreturn]] inline void overflow(OverflowData *d, Handle l, Handle r, const char *op) {
  report(d->loc,
         string(is_signed(d->type) ? "signed" : "unsigned") + " integer overflow: " + value(d->type, l) + " " + op +
             " " + value(d->type, r) + " cannot be represented in type " + d->type.name,
         &d->type);
}

// extern "C" keeps the symbol names unqualified despite the namespace.
#define LL_UBSAN(name, params, ...)                                 \
  [[noreturn]] void __ubsan_handle_##name params __VA_ARGS__        \
  [[noreturn]] void __ubsan_handle_##name##_abort params __VA_ARGS__

extern "C" {

LL_UBSAN(type_mismatch_v1, (TypeMismatchData * d, Handle p), {
  static const char *const kinds[] = {"load of", "store to", "reference binding to", "member access within",
                                      "member call on", "constructor call on", "downcast of", "downcast of",
                                      "upcast of", "cast to virtual base of", "_Nonnull binding to",
                                      "dynamic operation on"};
  const char *kind = d->check_kind < 12 ? kinds[d->check_kind] : "access of";
  if (!p) report(d->loc, string(kind) + " null pointer of type " + d->type.name);
  report(d->loc, string(kind) + " misaligned address for type " + d->type.name);
})
LL_UBSAN(add_overflow, (OverflowData * d, Handle l, Handle r), { overflow(d, l, r, "+"); })
LL_UBSAN(sub_overflow, (OverflowData * d, Handle l, Handle r), { overflow(d, l, r, "-"); })
LL_UBSAN(mul_overflow, (OverflowData * d, Handle l, Handle r), { overflow(d, l, r, "*"); })
LL_UBSAN(negate_overflow, (OverflowData * d, Handle v), {
  report(d->loc,
         "negation of " + value(d->type, v) + " cannot be represented in type " + d->type.name +
             "; cast to an unsigned type to negate this value to itself",
         &d->type);
})
LL_UBSAN(divrem_overflow, (OverflowData * d, Handle l, Handle r), {
  if (d->type.kind == 0 && unsigned_value(d->type, r) == 0) report(d->loc, "division by zero");
  report(d->loc, "division of " + value(d->type, l) + " by -1 cannot be represented in type " + d->type.name);
})
LL_UBSAN(shift_out_of_bounds, (ShiftData * d, Handle l, Handle r), {
  if (is_signed(d->rhs) && signed_value(d->rhs, r) < 0)
    report(d->loc, "shift exponent " + value(d->rhs, r) + " is negative");
  if (unsigned_value(d->rhs, r) >= bit_width(d->lhs))
    report(d->loc, "shift exponent " + value(d->rhs, r) + " is too large for " + std::to_string(bit_width(d->lhs)) +
                       "-bit type " + d->lhs.name);
  if (is_signed(d->lhs) && signed_value(d->lhs, l) < 0)
    report(d->loc, "left shift of negative value " + value(d->lhs, l));
  report(d->loc, "left shift of " + value(d->lhs, l) + " by " + value(d->rhs, r) +
                     " places cannot be represented in type " + d->lhs.name);
})
LL_UBSAN(out_of_bounds, (OutOfBoundsData * d, Handle i), {
  report(d->loc, "index " + value(d->index, i) + " out of bounds for type " + d->array.name);
})
LL_UBSAN(missing_return, (LocationData * d), {
  report(d->loc, "execution reached the end of a value-returning function without returning a value");
})
LL_UBSAN(builtin_unreachable, (LocationData * d), {
  report(d->loc, "execution reached an unreachable program point");
})
LL_UBSAN(vla_bound_not_positive, (VlaData * d, Handle v), {
  report(d->loc, "variable length array bound evaluates to non-positive value " + value(d->type, v));
})

}  // extern "C"

#undef LL_UBSAN

}  // namespace __ll::ubsan

// libc++ hardening (bounds-checked operator[], front() on empty containers, ...)
// and exceptions thrown by the library itself end up here.
_LIBCPP_BEGIN_NAMESPACE_STD
[[noreturn]] void __libcpp_verbose_abort(const char *format, ...) _NOEXCEPT {
  char buf[1024];
  va_list ap;
  va_start(ap, format);
  vsnprintf(buf, sizeof buf, format, ap);
  va_end(ap);
  string msg = buf;
  while (!msg.empty() && msg.back() == '\n') msg.pop_back();
  size_t failed = msg.find("failed: ");
  if (failed != string::npos) msg = msg.substr(failed + 8);
  __ll::runtime_error("Runtime Error: " + msg);
}
_LIBCPP_END_NAMESPACE_STD

// The sysroot's libc++abi is built without exception support. `throw` still
// compiles; an exception terminates the program the way an uncaught one does
// on LeetCode (catch blocks can't run).
extern "C" char *__cxa_demangle(const char *, char *, size_t *, int *);

extern "C" __attribute__((weak)) void *__cxa_allocate_exception(size_t size) noexcept {
  void *p = malloc(size ? size : 1);
  if (!p) __ll::runtime_error("terminate called: out of memory while throwing an exception");
  return p;
}

extern "C" __attribute__((weak)) void __cxa_free_exception(void *p) noexcept { free(p); }

extern "C" __attribute__((weak, noreturn)) void __cxa_throw(void *obj, std::type_info *type, void (*)(void *)) {
  int status = 0;
  char *name = __cxa_demangle(type->name(), nullptr, nullptr, &status);
  string pretty = status == 0 && name ? name : type->name();
  string msg = "terminate called after throwing an instance of '" + pretty + "'";
  static const std::type_info *const std_exceptions[] = {
      &typeid(std::exception),      &typeid(std::logic_error),        &typeid(std::runtime_error),
      &typeid(std::out_of_range),   &typeid(std::invalid_argument),   &typeid(std::length_error),
      &typeid(std::domain_error),   &typeid(std::range_error),        &typeid(std::overflow_error),
      &typeid(std::underflow_error), &typeid(std::bad_alloc),         &typeid(std::bad_array_new_length),
      &typeid(std::bad_function_call), &typeid(std::bad_optional_access), &typeid(std::bad_variant_access),
      &typeid(std::bad_cast),       &typeid(std::bad_any_cast),     &typeid(std::regex_error),
  };
  for (const std::type_info *t : std_exceptions) {
    if (*t == *type) {
      msg += string("\n  what():  ") + static_cast<std::exception *>(obj)->what();
      break;
    }
  }
  __ll::runtime_error(msg);
}

extern "C" __attribute__((weak, noreturn)) void __cxa_rethrow() {
  __ll::runtime_error("terminate called after rethrowing an exception");
}

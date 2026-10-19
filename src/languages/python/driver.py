"""LocalLeet Python harness.

Mirrors what LeetCode's judge does around a submission: parses the raw
testcase lines according to the problem's metaData, calls the user's
Solution (or design class), and serializes the result in LeetCode's output
format. Pure CPython, so it runs the same in Pyodide and in local tests.
"""

import io
import json
import linecache
import sys
import time
import traceback
from contextlib import redirect_stdout, redirect_stderr
from typing import List, Optional

USER_FILENAME = "solution.py"
MAX_STDOUT = 64 * 1024

# LeetCode imports most of the standard library into the submission's
# namespace for convenience; mirror that.
PRELUDE = """
import array, bisect, collections, copy, datetime, decimal, fractions, functools
import heapq, itertools, math, operator, random, re, statistics, string, sys
from array import *
from bisect import *
from collections import *
from copy import *
from functools import *
from heapq import *
from itertools import *
from math import *
from operator import *
from random import *
from statistics import *
from string import *
from typing import *
from fractions import Fraction
from decimal import Decimal
try:
    from sortedcontainers import SortedList, SortedDict, SortedSet
except ImportError:
    pass
"""


class ListNode:
    def __init__(self, val=0, next=None):
        self.val = val
        self.next = next

    def __repr__(self):
        return f"ListNode({self.val})"


class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val = val
        self.left = left
        self.right = right

    def __repr__(self):
        return f"TreeNode({self.val})"


class Node:
    """Graph node as used by e.g. Clone Graph."""

    def __init__(self, val=0, neighbors=None):
        self.val = val
        self.neighbors = neighbors if neighbors is not None else []


class HarnessError(Exception):
    """Problem with the testcase input rather than the user's code."""


# ---------------------------------------------------------------- conversion

def build_list(values) -> Optional[ListNode]:
    dummy = tail = ListNode()
    for v in values:
        tail.next = ListNode(v)
        tail = tail.next
    return dummy.next


def build_tree(values) -> Optional[TreeNode]:
    if not values or values[0] is None:
        return None
    root = TreeNode(values[0])
    queue = [root]
    i, head = 1, 0
    while i < len(values) and head < len(queue):
        node = queue[head]
        head += 1
        if i < len(values) and values[i] is not None:
            node.left = TreeNode(values[i])
            queue.append(node.left)
        i += 1
        if i < len(values) and values[i] is not None:
            node.right = TreeNode(values[i])
            queue.append(node.right)
        i += 1
    return root


def list_to_values(head, limit=100000):
    out, seen = [], 0
    while head is not None:
        out.append(head.val)
        head = head.next
        seen += 1
        if seen > limit:
            raise HarnessError("Returned linked list is too long (cycle?)")
    return out


def tree_to_values(root):
    if root is None:
        return []
    out, queue, head = [], [root], 0
    while head < len(queue):
        node = queue[head]
        head += 1
        if node is None:
            out.append(None)
            continue
        out.append(node.val)
        queue.append(node.left)
        queue.append(node.right)
    while out and out[-1] is None:
        out.pop()
    return out


def element_type(t):
    t = t.strip()
    if t.endswith("[]"):
        return t[:-2]
    lower = t.lower()
    if lower.startswith("list<") and t.endswith(">"):
        return t[5:-1]
    return None


def to_python(value, t):
    """Convert a JSON-decoded testcase value into the declared parameter type."""
    if t is None:
        return value
    inner = element_type(t)
    if inner is not None:
        if value is None:
            return None
        if not isinstance(value, list):
            raise HarnessError(f"Expected an array for type {t}, got {value!r}")
        return [to_python(v, inner) for v in value]
    base = t.lower()
    if base == "listnode":
        return build_list(value or [])
    if base == "treenode":
        return build_tree(value or [])
    if base in ("integer", "long", "int"):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise HarnessError(f"Expected an integer, got {value!r}")
        return int(value)
    if base in ("double", "float"):
        return float(value)
    if base == "boolean":
        return bool(value)
    if base in ("character", "char"):
        if not isinstance(value, str) or len(value) != 1:
            raise HarnessError(f"Expected a single character, got {value!r}")
        return value
    if base == "string":
        if not isinstance(value, str):
            raise HarnessError(f"Expected a string, got {value!r}")
        return value
    return value


def format_double(x):
    if x != x:
        return "NaN"
    if x in (float("inf"), float("-inf")):
        return "Infinity" if x > 0 else "-Infinity"
    return f"{x:.5f}"


def serialize(value, t=None):
    """Render a value the way LeetCode prints outputs."""
    inner = element_type(t) if t else None
    base = t.lower() if t else None
    if value is None:
        return "[]" if base in ("listnode", "treenode") else "null"
    if isinstance(value, ListNode):
        return serialize(list_to_values(value))
    if isinstance(value, TreeNode):
        return serialize(tree_to_values(value))
    if isinstance(value, bool):
        return "true" if value else "false"
    if base in ("double", "float") and isinstance(value, (int, float)):
        return format_double(float(value))
    if isinstance(value, float):
        if base in ("integer", "long") and value.is_integer():
            return str(int(value))
        return format_double(value)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, dict):
        return "{" + ",".join(
            f"{serialize(str(k))}:{serialize(v)}" for k, v in value.items()
        ) + "}"
    if isinstance(value, (list, tuple, set, frozenset)) or _is_iterable(value):
        return "[" + ",".join(serialize(v, inner) for v in value) + "]"
    return json.dumps(str(value))


def _is_iterable(value):
    if isinstance(value, (str, bytes)):
        return False
    try:
        iter(value)
        return True
    except TypeError:
        return False


def parse_line(line):
    line = line.strip()
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        pass
    # A few legacy problems use bare words for strings/characters.
    if line and not line.startswith(("[", "{", '"')):
        return line
    raise HarnessError(f"Could not parse testcase line: {line}")


# ---------------------------------------------------------------- execution

def compile_user(code):
    ns = {"__name__": "__main__", "__builtins__": __builtins__}
    exec(PRELUDE, ns)
    ns.update(ListNode=ListNode, TreeNode=TreeNode, Node=Node,
              List=List, Optional=Optional)
    # Register the source so tracebacks can show the offending lines.
    linecache.cache[USER_FILENAME] = (len(code), None, code.splitlines(True), USER_FILENAME)
    compiled = compile(code, USER_FILENAME, "exec")
    exec(compiled, ns)
    return ns


def format_user_exception(exc):
    """Traceback restricted to frames in the user's code, like LeetCode's."""
    tb = exc.__traceback__
    frames = [f for f in traceback.extract_tb(tb) if f.filename == USER_FILENAME]
    lines = []
    if frames:
        lines.append("Traceback (most recent call last):\n")
        for f in frames:
            lines.append(f'  Line {f.lineno} in {f.name} ({USER_FILENAME})\n')
            if f.line:
                lines.append(f"    {f.line.strip()}\n")
    lines.extend(traceback.format_exception_only(type(exc), exc))
    return "".join(lines).rstrip()


def call_function(ns, meta, args):
    if "Solution" not in ns:
        raise HarnessError("No `class Solution` found in your code")
    method = getattr(ns["Solution"](), meta["name"], None)
    if method is None:
        raise HarnessError(f"Solution has no method `{meta['name']}`")
    return method(*args)


def run_function(ns, meta, values, slug):
    params = meta.get("params", [])
    special = SPECIAL_CASES.get(slug)
    if special is not None:
        return special(ns, meta, values)
    args = [to_python(v, p.get("type")) for v, p in zip(values, params)]
    result = call_function(ns, meta, args)
    ret_type = (meta.get("return") or {}).get("type")
    output = meta.get("output") or {}
    if ret_type == "void" or "paramindex" in output:
        idx = output.get("paramindex", 0)
        return serialize(args[idx], params[idx].get("type"))
    return serialize(result, ret_type)


def run_design(ns, meta, values):
    if len(values) < 2:
        raise HarnessError("Design problems need two lines: method names and arguments")
    names, arglists = values[0], values[1]
    if len(names) != len(arglists):
        raise HarnessError("Method names and argument lists differ in length")
    classname = meta["classname"]
    if classname not in ns:
        raise HarnessError(f"No `class {classname}` found in your code")
    methods = {m["name"]: m for m in meta.get("methods", [])}
    ctor_params = (meta.get("constructor") or {}).get("params", [])
    out = []
    obj = None
    for i, (name, raw_args) in enumerate(zip(names, arglists)):
        if i == 0:
            args = [to_python(v, p.get("type")) for v, p in zip(raw_args, ctor_params)]
            obj = ns[classname](*args)
            out.append("null")
            continue
        spec = methods.get(name, {})
        args = [to_python(v, p.get("type")) for v, p in zip(raw_args, spec.get("params", []))]
        fn = getattr(obj, name, None)
        if fn is None:
            raise HarnessError(f"{classname} has no method `{name}`")
        result = fn(*args)
        ret_type = (spec.get("return") or {}).get("type")
        out.append("null" if ret_type == "void" else serialize(result, ret_type))
    return "[" + ",".join(out) + "]"


# Problems marked "manual" in metaData use custom judges on LeetCode. These
# adapters cover the common ones; others fall back to the generic driver.

def _linked_list_with_cycle(values):
    head = build_list(values[0])
    pos = values[1]
    nodes = []
    node = head
    while node is not None:
        nodes.append(node)
        node = node.next
    if pos is not None and 0 <= pos < len(nodes):
        nodes[-1].next = nodes[pos]
    return head, nodes


def _has_cycle(ns, meta, values):
    head, _ = _linked_list_with_cycle(values)
    return serialize(call_function(ns, meta, [head]), "boolean")


def _detect_cycle(ns, meta, values):
    head, nodes = _linked_list_with_cycle(values)
    result = call_function(ns, meta, [head])
    if result is None:
        return "no cycle"
    for i, n in enumerate(nodes):
        if n is result:
            return f"tail connects to node index {i}"
    raise HarnessError("Returned node is not part of the input list")


def _intersection(ns, meta, values):
    intersect_val, list_a, list_b, skip_a, skip_b = values[:5]

    def attach(head, tail):
        if head is None:
            return tail
        node = head
        while node.next is not None:
            node = node.next
        node.next = tail
        return head

    if intersect_val:
        shared = build_list(list_a[skip_a:])
        a = attach(build_list(list_a[:skip_a]), shared)
        b = attach(build_list(list_b[:skip_b]), shared)
    else:
        a = build_list(list_a)
        b = build_list(list_b)
    result = call_function(ns, meta, [a, b])
    if result is None:
        return "No intersection"
    return f"Intersected at '{result.val}'"


def _find_tree_node(root, val):
    stack = [root]
    while stack:
        node = stack.pop()
        if node is None:
            continue
        if node.val == val:
            return node
        stack.append(node.left)
        stack.append(node.right)
    raise HarnessError(f"No node with value {val} in the tree")


def _lca(ns, meta, values):
    root = build_tree(values[0])
    nodes = [_find_tree_node(root, v) for v in values[1:]]
    result = call_function(ns, meta, [root, *nodes])
    return "null" if result is None else serialize(result.val)


def _clone_graph(ns, meta, values):
    adjacency = values[0]
    nodes = [Node(i + 1) for i in range(len(adjacency))]
    for node, neighbors in zip(nodes, adjacency):
        node.neighbors = [nodes[n - 1] for n in neighbors]
    result = call_function(ns, meta, [nodes[0] if nodes else None])
    if result is None:
        return "[]"
    seen = {}
    queue = [result]
    while queue:
        node = queue.pop()
        if node.val in seen:
            continue
        if any(node is n for n in nodes):
            raise HarnessError("Returned graph shares nodes with the input")
        seen[node.val] = node
        queue.extend(node.neighbors)
    out = [[n.val for n in seen[v].neighbors] for v in sorted(seen)]
    return serialize(out)


SPECIAL_CASES = {
    "linked-list-cycle": _has_cycle,
    "linked-list-cycle-ii": _detect_cycle,
    "intersection-of-two-linked-lists": _intersection,
    "lowest-common-ancestor-of-a-binary-tree": _lca,
    "lowest-common-ancestor-of-a-binary-search-tree": _lca,
    "clone-graph": _clone_graph,
}


def lines_per_case(meta):
    if meta.get("systemdesign"):
        return 2
    return max(1, len(meta.get("params", [])))


def run_case(ns, meta, lines, slug=None):
    """Run one testcase. Returns a dict suitable for JSON transport."""
    stdout = io.StringIO()
    result = {"status": "ok", "output": None, "stdout": "", "error": None, "time_ms": 0.0}
    start = time.perf_counter()
    try:
        values = [parse_line(line) for line in lines]
        with redirect_stdout(stdout), redirect_stderr(stdout):
            if meta.get("systemdesign"):
                result["output"] = run_design(ns, meta, values)
            else:
                result["output"] = run_function(ns, meta, values, slug)
    except HarnessError as e:
        result["status"] = "harness_error"
        result["error"] = str(e)
    except RecursionError as e:
        result["status"] = "runtime_error"
        result["error"] = format_user_exception(e)
    except Exception as e:
        result["status"] = "runtime_error"
        result["error"] = format_user_exception(e)
    result["time_ms"] = (time.perf_counter() - start) * 1000
    out = stdout.getvalue()
    if len(out) > MAX_STDOUT:
        out = out[:MAX_STDOUT] + "\n... (stdout truncated)"
    result["stdout"] = out
    return result


def run_all(code, meta_json, cases_json, slug=None, on_result=None):
    """Compile once, then run each case. Returns a JSON string.

    If `on_result` is given it is called with each case's JSON as it
    finishes, so the host can stream progress and enforce timeouts.
    """
    meta = json.loads(meta_json)
    cases = json.loads(cases_json)
    try:
        ns = compile_user(code)
    except SyntaxError as e:
        msg = "".join(traceback.format_exception_only(type(e), e)).rstrip()
        msg = msg.replace(f'File "{USER_FILENAME}", line', "Line")
        return json.dumps({"compile_error": msg})
    except Exception as e:
        return json.dumps({"compile_error": format_user_exception(e)})
    results = []
    for lines in cases:
        r = run_case(ns, meta, lines, slug)
        results.append(r)
        if on_result is not None:
            on_result(json.dumps(r))
    return json.dumps({"results": results})

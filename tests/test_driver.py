"""Tests for the Python harness. Run with: python3 -m unittest discover tests"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src", "languages", "python"))
import driver  # noqa: E402


def run(code, meta, *cases, slug=None):
    out = json.loads(driver.run_all(code, json.dumps(meta), json.dumps(list(cases)), slug))
    return out


class DriverTest(unittest.TestCase):
    def test_two_sum(self):
        code = """
class Solution:
    def twoSum(self, nums: List[int], target: int) -> List[int]:
        seen = {}
        for i, n in enumerate(nums):
            if target - n in seen:
                print("found", i)
                return [seen[target - n], i]
            seen[n] = i
"""
        meta = {"name": "twoSum",
                "params": [{"name": "nums", "type": "integer[]"}, {"name": "target", "type": "integer"}],
                "return": {"type": "integer[]"}}
        out = run(code, meta, ["[2,7,11,15]", "9"], ["[3,3]", "6"])
        r = out["results"]
        self.assertEqual([x["output"] for x in r], ["[0,1]", "[0,1]"])
        self.assertEqual(r[0]["stdout"], "found 1\n")

    def test_linked_list(self):
        code = """
class Solution:
    def addTwoNumbers(self, l1, l2):
        dummy = cur = ListNode()
        carry = 0
        while l1 or l2 or carry:
            s = carry + (l1.val if l1 else 0) + (l2.val if l2 else 0)
            carry, d = divmod(s, 10)
            cur.next = ListNode(d); cur = cur.next
            l1 = l1 and l1.next; l2 = l2 and l2.next
        return dummy.next
"""
        meta = {"name": "addTwoNumbers",
                "params": [{"name": "l1", "type": "ListNode"}, {"name": "l2", "type": "ListNode"}],
                "return": {"type": "ListNode"}}
        r = run(code, meta, ["[2,4,3]", "[5,6,4]"], ["[9,9,9,9,9,9,9]", "[9,9,9,9]"])["results"]
        self.assertEqual([x["output"] for x in r], ["[7,0,8]", "[8,9,9,9,0,0,0,1]"])

    def test_tree_roundtrip(self):
        code = """
class Solution:
    def invertTree(self, root):
        if root:
            root.left, root.right = self.invertTree(root.right), self.invertTree(root.left)
        return root
"""
        meta = {"name": "invertTree", "params": [{"name": "root", "type": "TreeNode"}],
                "return": {"type": "TreeNode"}}
        r = run(code, meta, ["[4,2,7,1,3,6,9]"], ["[]"], ["[1,null,2]"])["results"]
        self.assertEqual([x["output"] for x in r], ["[4,7,2,9,6,3,1]", "[]", "[1,2]"])

    def test_void_in_place(self):
        code = """
class Solution:
    def rotate(self, matrix):
        matrix[:] = [list(r) for r in zip(*matrix[::-1])]
"""
        meta = {"name": "rotate", "params": [{"name": "matrix", "type": "integer[][]"}],
                "return": {"type": "void"}, "output": {"paramindex": 0}}
        r = run(code, meta, ["[[1,2,3],[4,5,6],[7,8,9]]"])["results"]
        self.assertEqual(r[0]["output"], "[[7,4,1],[8,5,2],[9,6,3]]")

    def test_design(self):
        code = """
class LRUCache:
    def __init__(self, capacity: int):
        self.cap = capacity; self.d = OrderedDict()
    def get(self, key: int) -> int:
        if key not in self.d: return -1
        self.d.move_to_end(key); return self.d[key]
    def put(self, key: int, value: int) -> None:
        self.d[key] = value; self.d.move_to_end(key)
        if len(self.d) > self.cap: self.d.popitem(last=False)
"""
        meta = {"classname": "LRUCache", "systemdesign": True,
                "constructor": {"params": [{"type": "integer", "name": "capacity"}]},
                "methods": [
                    {"name": "get", "params": [{"type": "integer", "name": "key"}], "return": {"type": "integer"}},
                    {"name": "put", "params": [{"type": "integer", "name": "key"}, {"type": "integer", "name": "value"}],
                     "return": {"type": "void"}}]}
        r = run(code, meta, [
            '["LRUCache","put","put","get","put","get","put","get","get","get"]',
            "[[2],[1,1],[2,2],[1],[3,3],[2],[4,4],[1],[3],[4]]"])["results"]
        self.assertEqual(r[0]["output"], "[null,null,null,1,null,-1,null,-1,3,4]")

    def test_double_and_strings(self):
        code = """
class Solution:
    def myPow(self, x: float, n: int) -> float:
        return x ** n
    def label(self, s: str) -> List[str]:
        return [s, s.upper()]
"""
        meta = {"name": "myPow", "params": [{"name": "x", "type": "double"}, {"name": "n", "type": "integer"}],
                "return": {"type": "double"}}
        r = run(code, meta, ["2.00000", "10"], ["2.00000", "-2"])["results"]
        self.assertEqual([x["output"] for x in r], ["1024.00000", "0.25000"])
        meta = {"name": "label", "params": [{"name": "s", "type": "string"}], "return": {"type": "list<string>"}}
        r = run(code, meta, ['"héllo"'])["results"]
        self.assertEqual(r[0]["output"], '["héllo","HÉLLO"]')

    def test_runtime_error_traceback(self):
        code = """class Solution:
    def f(self, n: int) -> int:
        return 1 // n
"""
        meta = {"name": "f", "params": [{"name": "n", "type": "integer"}], "return": {"type": "integer"}}
        r = run(code, meta, ["0"], ["1"])["results"]
        self.assertEqual(r[0]["status"], "runtime_error")
        self.assertIn("ZeroDivisionError", r[0]["error"])
        self.assertIn("Line 3", r[0]["error"])
        self.assertNotIn("driver.py", r[0]["error"])
        self.assertEqual(r[1]["output"], "1")

    def test_compile_error(self):
        out = run("class Solution:\n    def f(self)\n", {"name": "f", "params": []}, [])
        self.assertIn("SyntaxError", out["compile_error"])

    def test_prelude_imports(self):
        code = """
class Solution:
    def f(self, nums: List[int]) -> int:
        h = list(nums); heapify(h)
        return heappop(h) + len(Counter(nums)) + gcd(4, 6) + bisect_left(sorted(nums), 3)
"""
        meta = {"name": "f", "params": [{"name": "nums", "type": "integer[]"}], "return": {"type": "integer"}}
        r = run(code, meta, ["[3,1,2,3]"])["results"]
        self.assertEqual(r[0]["output"], str(1 + 3 + 2 + 2))

    def test_linked_list_cycle(self):
        code = """
class Solution:
    def hasCycle(self, head) -> bool:
        slow = fast = head
        while fast and fast.next:
            slow, fast = slow.next, fast.next.next
            if slow is fast: return True
        return False
"""
        meta = {"name": "hasCycle", "params": [{"name": "head", "type": "ListNode"}, {"name": "pos", "type": "integer"}],
                "return": {"type": "boolean"}, "manual": True}
        r = run(code, meta, ["[3,2,0,-4]", "1"], ["[1]", "-1"], slug="linked-list-cycle")["results"]
        self.assertEqual([x["output"] for x in r], ["true", "false"])

    def test_lca(self):
        code = """
class Solution:
    def lowestCommonAncestor(self, root, p, q):
        if root in (None, p, q): return root
        l = self.lowestCommonAncestor(root.left, p, q)
        r = self.lowestCommonAncestor(root.right, p, q)
        return root if l and r else l or r
"""
        meta = {"name": "lowestCommonAncestor",
                "params": [{"name": "root", "type": "TreeNode"}, {"name": "p", "type": "integer"},
                           {"name": "q", "type": "integer"}],
                "return": {"type": "TreeNode"}, "manual": True}
        r = run(code, meta, ["[3,5,1,6,2,0,8,null,null,7,4]", "5", "4"],
                slug="lowest-common-ancestor-of-a-binary-tree")["results"]
        self.assertEqual(r[0]["output"], "5")

    def test_intersection(self):
        code = """
class Solution:
    def getIntersectionNode(self, a, b):
        x, y = a, b
        while x is not y:
            x = x.next if x else b
            y = y.next if y else a
        return x
"""
        meta = {"name": "getIntersectionNode", "params": [], "manual": True}
        r = run(code, meta, ["8", "[4,1,8,4,5]", "[5,6,1,8,4,5]", "2", "3"],
                ["0", "[2,6,4]", "[1,5]", "3", "2"], slug="intersection-of-two-linked-lists")["results"]
        self.assertEqual([x["output"] for x in r], ["Intersected at '8'", "No intersection"])

    def test_clone_graph(self):
        code = """
class Solution:
    def cloneGraph(self, node):
        memo = {}
        def go(n):
            if n is None: return None
            if n in memo: return memo[n]
            c = memo[n] = Node(n.val)
            c.neighbors = [go(x) for x in n.neighbors]
            return c
        return go(node)
"""
        meta = {"name": "cloneGraph", "params": [{"name": "edges", "type": "integer[][]"}], "manual": True}
        r = run(code, meta, ["[[2,4],[1,3],[2,4],[1,3]]"], ["[]"], slug="clone-graph")["results"]
        self.assertEqual([x["output"] for x in r], ["[[2,4],[1,3],[2,4],[1,3]]", "[]"])

    def test_bad_input_is_harness_error(self):
        meta = {"name": "f", "params": [{"name": "n", "type": "integer"}]}
        r = run("class Solution:\n    def f(self, n): return n\n", meta, ["[1,"])["results"]
        self.assertEqual(r[0]["status"], "harness_error")


if __name__ == "__main__":
    unittest.main()

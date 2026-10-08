"""kit.py's layouts, against a stand-in for manimlib that records what is built. Standard library only."""
import sys
import types
import unittest


class Obj:
    """A mobject stand-in: a centre that moves, points, and corners."""

    def __init__(self, x=0.0):
        self.x = x

    def get_center(self):
        return [self.x, 0, 0]

    def get_points(self):
        return [1]

    def shift(self, v):
        self.x += v[0]
        return self


class FakeTex(Obj):
    def __init__(self, line, **kw):
        super().__init__()
        self.line, self.kw = line, kw
        self.at = line.find("=") * 0.1 if "=" in line else 0  # where its equals sign sits

    def select_part(self, sel):
        owner = self

        class Part(Obj):
            def get_center(self):
                return [owner.x + owner.at, 0, 0]
        return Part()


class FakeGroup(list):
    def __init__(self, *items):
        super().__init__(items)

    def arrange(self, *a, **k):
        return self


class Vec(list):
    """Enough of a numpy vector for `number * RIGHT`."""

    def __rmul__(self, k):
        return Vec(k * v for v in self)

    __mul__ = __rmul__


def fake_manimlib():
    m = types.ModuleType("manimlib")
    for name in ["DL", "UR", "DOWN"]:
        setattr(m, name, Vec([0, 0, 0]))
    m.RIGHT = Vec([1, 0, 0])
    m.GREY_A, m.RED, m.YELLOW = "grey", "red", "yellow"
    m.Tex, m.VGroup = FakeTex, FakeGroup
    m.Line = m.SurroundingRectangle = m.Text = m.Axes = object
    return m


class KitTest(unittest.TestCase):
    def setUp(self):
        sys.modules["manimlib"] = fake_manimlib()
        sys.modules.pop("kit", None)
        import kit
        self.kit = kit

    def tearDown(self):
        sys.modules.pop("manimlib", None)
        sys.modules.pop("kit", None)

    def test_derivation_lines_up_equals_signs_and_isolates_them(self):
        rows = self.kit.derivation("L = x", "dL/dy = y - t", "and so")
        self.assertEqual([r.kw["isolate"] for r in rows], [["="], ["="], []])
        self.assertAlmostEqual(rows[0].x + rows[0].at, rows[1].x + rows[1].at)
        self.assertEqual(rows[2].x, 0, "a line without = stays centred")

    def test_derivation_passes_colours_through(self):
        rows = self.kit.derivation("a = b", t2c={"a": "red"})
        self.assertEqual(rows[0].kw["t2c"], {"a": "red"})


if __name__ == "__main__":
    unittest.main()

"""splice.py: an edit naming only what changes, applied to script.txt and scenes.py."""
import json
import tempfile
import unittest
from pathlib import Path

from splice import SpliceError, apply, main, splice_scenes, splice_script

SCRIPT = """# Gradient of the squared error
[intro]
Every line has a <mark name="slope"/>slope.

# --- the chain rule ---
[chain]
# keep this short
Two links.

[outro]
That is all.
"""

SCENES = '''from manimlib import *
from voiceover import VoiceoverScene

COLORS = {"w": BLUE}


class Intro(VoiceoverScene, Scene):
    def construct(self):
        with self.voiceover("intro") as vo:
            self.wait(vo.remaining())


# The chain rule, link by link.
class Chain(VoiceoverScene, Scene):
    def construct(self):
        with self.voiceover("chain") as vo:
            self.wait(vo.remaining())


class Outro(VoiceoverScene, Scene):
    def construct(self):
        with self.voiceover("outro") as vo:
            self.wait(vo.remaining())
'''

CHAIN2 = '''class Chain(VoiceoverScene, Scene):
    def construct(self):
        with self.voiceover("chain") as vo:
            self.play(FadeIn(Tex("x")), run_time=vo.remaining())'''


class ScriptTest(unittest.TestCase):
    def test_a_block_is_replaced_in_place_keeping_its_comments(self):
        out, changed, new, removed = splice_script(SCRIPT, [{"id": "chain", "text": "Three links now."}], [])
        self.assertEqual(changed, ["chain"])
        self.assertIn("# --- the chain rule ---\n[chain]\n# keep this short\nThree links now.\n\n[outro]", out)
        self.assertTrue(out.startswith("# Gradient of the squared error\n[intro]\nEvery line has a <mark name=\"slope\"/>slope."))

    def test_new_blocks_go_after_the_one_named_and_others_can_be_removed(self):
        out, changed, new, removed = splice_script(SCRIPT, [{"id": "chain2", "text": "One at a time.", "after": "chain"}], ["outro"])
        self.assertEqual((new, removed), (["chain2"], ["outro"]))
        self.assertIn("Two links.\n\n[chain2]\nOne at a time.\n", out)
        self.assertNotIn("[outro]", out)

    def test_an_unknown_block_without_a_place_is_refused(self):
        with self.assertRaisesRegex(SpliceError, r'\[nope\] is not in the script. To add it, give "after"'):
            splice_script(SCRIPT, [{"id": "nope", "text": "x"}], [])
        with self.assertRaisesRegex(SpliceError, r"after \[ghost\], which is not in the script"):
            splice_script(SCRIPT, [{"id": "new", "text": "x", "after": "ghost"}], [])
        with self.assertRaisesRegex(SpliceError, "has no text"):
            splice_script(SCRIPT, [{"id": "intro", "text": "  "}], [])

    def test_unchanged_text_is_not_reported_as_a_change(self):
        _, changed, _, _ = splice_script(SCRIPT, [{"id": "outro", "text": "That is all."}], [])
        self.assertEqual(changed, [])


class ScenesTest(unittest.TestCase):
    def test_a_class_is_replaced_by_its_exact_range(self):
        out, changed, new, removed, pre = splice_scenes(SCENES, [{"name": "Chain", "code": CHAIN2}], [], "")
        self.assertEqual(changed, ["Chain"])
        self.assertIn('self.play(FadeIn(Tex("x")), run_time=vo.remaining())', out)
        self.assertNotIn("# The chain rule, link by link.", out, "the comment directly above goes with the class")
        self.assertIn("class Intro", out)
        self.assertIn("class Outro", out)
        self.assertEqual(out.count("class "), 3)

    def test_new_classes_go_after_the_one_named_or_at_the_end(self):
        code = CHAIN2.replace("class Chain", "class ChainTwo").replace('"chain"', '"chain2"')
        out, _, new, _, _ = splice_scenes(SCENES, [{"name": "ChainTwo", "code": code, "after": "Chain"}, {"name": "End", "code": "class End(VoiceoverScene, Scene):\n    pass", "after": ""}], [], "")
        self.assertEqual(new, ["ChainTwo", "End"])
        order = [line.split("(")[0][6:] for line in out.splitlines() if line.startswith("class ")]
        self.assertEqual(order, ["Intro", "Chain", "ChainTwo", "Outro", "End"])

    def test_a_replaced_class_and_one_after_it_both_land(self):
        code = CHAIN2.replace("class Chain", "class ChainTwo")
        out, *_ = splice_scenes(SCENES, [{"name": "Chain", "code": CHAIN2}, {"name": "ChainTwo", "code": code, "after": "Chain"}], ["Outro"], "")
        order = [line.split("(")[0][6:] for line in out.splitlines() if line.startswith("class ")]
        self.assertEqual(order, ["Intro", "Chain", "ChainTwo"])

    def test_the_preamble_can_change(self):
        out, _, _, _, pre = splice_scenes(SCENES, [], [], 'from manimlib import *\nfrom voiceover import VoiceoverScene\n\nCOLORS = {"w": RED}')
        self.assertTrue(pre)
        self.assertIn('COLORS = {"w": RED}', out)
        self.assertEqual(out.count("class "), 3)

    def test_decorators_go_with_their_class(self):
        source = SCENES.replace("class Outro", "@some_decorator\nclass Outro")
        out, *_ = splice_scenes(source, [], ["Outro"], "")
        self.assertNotIn("some_decorator", out)

    def test_code_that_does_not_parse_or_define_the_class_is_refused(self):
        with self.assertRaisesRegex(SpliceError, "The code for Chain does not parse"):
            splice_scenes(SCENES, [{"name": "Chain", "code": "class Chain(:\n  pass"}], [], "")
        with self.assertRaisesRegex(SpliceError, "does not define class Chain"):
            splice_scenes(SCENES, [{"name": "Chain", "code": "class Other:\n  pass"}], [], "")
        with self.assertRaisesRegex(SpliceError, "not a class in scenes.py"):
            splice_scenes(SCENES, [], ["Ghost"], "")


class ApplyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "script.txt").write_text(SCRIPT)
        (self.root / "scenes.py").write_text(SCENES)

    def tearDown(self):
        self.tmp.cleanup()

    def test_nothing_is_written_when_any_part_fails(self):
        result = apply(self.root, {"blocks": [{"id": "chain", "text": "New."}], "classes": [{"name": "Chain", "code": "nope("}]})
        self.assertFalse(result["ok"])
        self.assertEqual((self.root / "script.txt").read_text(), SCRIPT)

    def test_the_command_reports_what_changed(self):
        edit = self.root / "edit.json"
        edit.write_text(json.dumps({"blocks": [{"id": "chain", "text": "New."}], "classes": [{"name": "Chain", "code": CHAIN2}]}))
        from io import StringIO
        from contextlib import redirect_stdout
        out = StringIO()
        with redirect_stdout(out):
            code = main([str(self.root), "--edit", str(edit)])
        result = json.loads(out.getvalue())
        self.assertEqual(code, 0)
        self.assertEqual(result["changed"]["blocks"], ["chain"])
        self.assertEqual(result["changed"]["classes"], ["Chain"])
        self.assertIn("New.", (self.root / "script.txt").read_text())


if __name__ == "__main__":
    unittest.main()

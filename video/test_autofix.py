"""autofix.py: the mistakes fixed without asking a model. Standard library only."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from autofix import closest, fix_source

HERE = Path(__file__).resolve().parent

SCENE = '''from manimlib import *
from voiceover import VoiceoverScene


class Intro(VoiceoverScene, Scene):
    def construct(self):
        axes = Axes((0, 4), (0, 4))
        eq = MathTex(R"\\hat{y}").set_color(GRAY_B)
        with self.voiceover("intro") as vo:
            self.play(Create(axes), run_time=vo.until("slpoe"))
            graph = axes.plot(lambda x: x).set_stroke(LIGHT_GRAY)
            self.play(self.camera.frame.animate.scale(0.5), ShowCreation(graph))
'''


class FixSourceTest(unittest.TestCase):
    def test_names_from_the_other_manim_become_manimgl_names(self):
        fixed, fixes = fix_source(SCENE)
        self.assertIn('Tex(R"\\hat{y}").set_color(GREY_B)', fixed)
        self.assertIn("self.play(ShowCreation(axes)", fixed)
        self.assertIn("axes.get_graph(lambda x: x).set_stroke(GREY_B)", fixed)
        self.assertIn("self.play(self.frame.animate.scale(0.5), ShowCreation(graph))", fixed)
        self.assertEqual(len(fixes), 6)
        self.assertEqual(fix_source(fixed), (fixed, []))  # nothing left to fix

    def test_a_name_the_file_defines_itself_is_left_alone(self):
        source = "GRAY = '#888888'\nclass Create(Animation):\n    pass\nx = Create(GRAY)\n"
        self.assertEqual(fix_source(source), (source, []))

    def test_a_mistyped_mark_or_block_is_corrected_on_the_line_the_check_named(self):
        errors = [
            {"where": "scenes.py", "message": 'line 10: block "intro" has no mark "slpoe". Its marks: rise, slope'},
            {"where": "scenes.py", "message": 'line 9: self.voiceover("Intro") names a block that is not in the script. Blocks: intro, outro'},
        ]
        fixed, fixes = fix_source(SCENE.replace('voiceover("intro")', 'voiceover("Intro")'), errors)
        self.assertIn('vo.until("slope")', fixed)
        self.assertIn('self.voiceover("intro")', fixed)
        self.assertIn('line 10: mark "slpoe" in block "intro" is "slope"', fixes)

    def test_no_guess_when_two_names_are_equally_close_or_none_is(self):
        self.assertIsNone(closest("rise", ["rose", "rice"]))
        self.assertIsNone(closest("gradient", ["slope", "rise"]))
        self.assertEqual(closest("Slope", ["slope", "rise"]), "slope")


class CommandTest(unittest.TestCase):
    def test_it_rewrites_scenes_py_and_says_what_it_did(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "project.json").write_text(json.dumps({"scenes_file": "scenes.py"}))
            (root / "scenes.py").write_text(SCENE)
            report = root / "check.json"
            report.write_text(json.dumps({"errors": [{"where": "scenes.py", "message": 'line 10: block "intro" has no mark "slpoe". Its marks: slope'}]}))
            done = subprocess.run([sys.executable, str(HERE / "autofix.py"), str(root), "--report", str(report)], capture_output=True, text=True, check=True)
            result = json.loads(done.stdout)
            self.assertTrue(result["changed"])
            self.assertIn('vo.until("slope")', (root / "scenes.py").read_text())
            done = subprocess.run([sys.executable, str(HERE / "autofix.py"), str(root)], capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(done.stdout), {"changed": False, "fixes": []})


if __name__ == "__main__":
    unittest.main()

"""check.py's reading of a project's files. Standard library only: nothing is spoken or run."""
import json
import tempfile
import unittest
from pathlib import Path

from check import Report, check, check_static, tidy, write_storyboard

SCRIPT = """# a comment
[intro]
Every line has a <mark name="slope"/>slope.

[outro]
That is all.
"""

SCENES = """from manimlib import *
from voiceover import VoiceoverScene


class Intro(VoiceoverScene, Scene):
    def construct(self):
        with self.voiceover("intro") as vo:
            self.play(Write(Text("Slope")), run_time=vo.until("slope"))
            self.wait(vo.remaining())


class Outro(VoiceoverScene, Scene):
    def construct(self):
        with self.voiceover("outro") as vo:
            self.wait(vo.remaining())
"""


class StaticCheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.write(script=SCRIPT, scenes=SCENES)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, script=None, scenes=None, config=None):
        if script is not None:
            (self.root / "script.txt").write_text(script, encoding="utf-8")
        if scenes is not None:
            (self.root / "scenes.py").write_text(scenes, encoding="utf-8")
        config = {"voice": "af_heart", "scenes": ["Intro", "Outro"]} if config is None else config
        (self.root / "project.json").write_text(json.dumps(config), encoding="utf-8")

    def errors(self, **kw):
        result = check(self.root, static_only=True, **kw)
        return [e["message"] for e in result["errors"]], result

    def assertOneError(self, fragment, **kw):
        errors, _ = self.errors(**kw)
        self.assertEqual(len(errors), 1, errors)
        self.assertIn(fragment, errors[0])

    def test_a_sound_project_passes_and_reports_its_scenes_and_blocks(self):
        errors, result = self.errors()
        self.assertEqual(errors, [])
        self.assertTrue(result["ok"])
        self.assertEqual(result["scenes"], ["Intro", "Outro"])
        self.assertEqual(result["blocks"], [{"id": "intro", "words": 5}, {"id": "outro", "words": 3}])

    def test_sync_scenes_writes_the_classes_found_in_order(self):
        self.write(config={"voice": "af_heart", "scenes": []})
        self.assertOneError('"scenes" is empty')
        errors, _ = self.errors(sync_scenes=True)
        self.assertEqual(errors, [])
        saved = json.loads((self.root / "project.json").read_text())
        self.assertEqual(saved, {"voice": "af_heart", "scenes": ["Intro", "Outro"]})

    def test_problems_carry_their_file_line_and_block_for_an_editor(self):
        self.write(scenes=SCENES.replace('vo.until("slope")', 'vo.until("slpoe")'))
        _, result = self.errors()
        e = result["errors"][0]
        self.assertEqual((e["file"], e["line"]), ("scenes.py", 8))
        self.write(scenes=SCENES, script=SCRIPT.replace("That is all.", 'That is <b>all</b>.'))
        _, result = self.errors()
        e = result["errors"][0]
        self.assertEqual((e["file"], e["line"], e["block"]), ("script.txt", 5, "outro"))
        self.write(script=SCRIPT + "\n[spare]\nNot played.\n")
        _, result = self.errors()
        e = result["errors"][0]
        self.assertEqual((e["file"], e["line"], e["block"]), ("script.txt", 8, "spare"))

    def test_a_scene_failure_points_at_the_last_scenes_line_of_its_traceback(self):
        report = Report()
        report.files = {"script": "script.txt", "scenes": "scenes.py"}
        report.block_lines["scenes"] = {"intro": 7}
        report.error("Intro", 'Traceback (most recent call last):\n  File "/x/scenes.py", line 8, in construct\n  File "/v/manimlib/mobject.py", line 90, in f\nNameError: x')
        report.warn("Intro", "text overlaps", block="intro", scene="Intro")
        self.assertEqual({k: report.errors[0][k] for k in ("file", "line", "scene")}, {"file": "scenes.py", "line": 8, "scene": "Intro"})
        self.assertEqual({k: report.warnings[0][k] for k in ("file", "line", "block")}, {"file": "scenes.py", "line": 7, "block": "intro"})

    def test_a_syntax_error_names_its_line(self):
        self.write(scenes=SCENES.replace('self.wait(vo.remaining())\n\n\nclass', 'self.wait(vo.remaining()\n\n\nclass'))
        errors, _ = self.errors()
        self.assertTrue(errors[0].startswith("line "), errors)

    def test_an_unknown_block_or_mark_lists_the_real_ones(self):
        self.write(scenes=SCENES.replace('voiceover("outro")', 'voiceover("ending")'))
        errors, _ = self.errors()
        self.assertIn('names a block that is not in the script. Blocks: intro, outro', errors[0])
        self.assertIn('narration block "outro" is never played', errors[1])
        self.write(scenes=SCENES.replace('until("slope")', 'until("rise")'))
        self.assertOneError('block "intro" has no mark "rise". Its marks: slope')

    def test_a_block_played_twice_or_a_computed_id_is_an_error(self):
        self.write(scenes=SCENES.replace('voiceover("outro")', 'voiceover("intro")').replace("class Outro", "class Again"))
        errors, _ = self.errors(sync_scenes=True)
        self.assertIn('block "intro" is already played by Intro', errors[0])
        self.write(scenes=SCENES.replace('voiceover("outro")', 'voiceover(name)'))
        errors, _ = self.errors()
        self.assertIn("needs the block id written out as a string", errors[0])

    def test_scenes_may_only_import_what_they_need(self):
        self.write(scenes="import os\nimport subprocess as sp\nfrom urllib.request import urlopen\n" + SCENES)
        errors, _ = self.errors()
        self.assertEqual(len(errors), 3, errors)
        self.assertIn("importing os is not allowed", errors[0])
        self.write(scenes=SCENES + "\nopen('/etc/passwd')\nx = ().__class__\n")
        errors, _ = self.errors()
        self.assertEqual(len(errors), 2, errors)
        self.assertIn("open is not allowed", " ".join(errors))
        self.assertIn("__class__ is not allowed", " ".join(errors))

    def test_strict_rules_for_scenes_a_model_wrote(self):
        self.assertEqual(self.errors(strict=True)[0], [], "an ordinary generated scene passes")
        for line, fragment in [
            ("import sys", "importing sys is not allowed"),
            ("from pathlib import Path", "importing pathlib is not allowed"),
            ("os.getcwd()", "os is not allowed"),
            ("sp.run(['ls'])", "sp is not allowed"),
            ("getattr(np, 'lo' + 'ad')", "getattr is not allowed"),
            ("np.load('x.npy')", ".load is not allowed"),
            ("np.savetxt('x', [1])", ".savetxt is not allowed"),
            ("x = '__subclasses__'", "double-underscore attribute"),
            ("vars(np)", "vars is not allowed"),
        ]:
            self.write(scenes=SCENES + "\n" + line + "\n")
            errors, _ = self.errors(strict=True)
            self.assertTrue(any(fragment in e for e in errors), (line, errors))
        # A hand-written project may still find its own files.
        self.write(scenes="import sys\nfrom pathlib import Path\n" + SCENES)
        self.assertEqual(self.errors()[0], [])

    def test_script_problems_are_reported(self):
        self.write(script="Hello before any block\n")
        errors, _ = self.errors()
        self.assertIn("text before the first [block-id] line", errors[0])
        self.write(script=SCRIPT.replace("That is all.", "That is <b>all</b>."))
        self.assertOneError("has a tag that is not a mark")
        self.write(script=SCRIPT.replace("slope.", 'slope <mark name="slope"/>again.'))
        self.assertOneError('uses the mark name "slope" more than once')

    def test_a_file_with_no_scene_classes_or_a_wrong_base_order(self):
        self.write(scenes="from manimlib import *\n")
        errors, _ = self.errors()
        self.assertIn("no scene classes found", errors[0])
        self.write(scenes=SCENES.replace("Intro(VoiceoverScene, Scene)", "Intro(Scene, VoiceoverScene)"))
        self.assertOneError("must list VoiceoverScene first")

    def test_project_json_listing_a_missing_scene(self):
        self.write(config={"scenes": ["Intro", "Nope"]})
        self.assertOneError("lists Nope, which is not a scene class")

    def test_a_missing_project_file_is_an_error_not_a_crash(self):
        (self.root / "project.json").write_text("{not json", encoding="utf-8")
        report = Report()
        self.assertEqual(check_static(self.root, report), (None, None, None))
        self.assertIn("cannot be read", report.errors[0]["message"])


class PromptExampleTest(unittest.TestCase):
    """The worked example in the lesson writer's prompt is what Claude imitates, so it must stay valid."""

    def test_the_example_shown_to_claude_passes_the_static_check(self):
        example = Path(__file__).resolve().parent.parent / "tts-studio" / "author" / "prompts" / "example"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ("script.txt", "scenes.py"):
                (root / name).write_text((example / name).read_text(encoding="utf-8"), encoding="utf-8")
            (root / "project.json").write_text('{"voice": "af_heart", "scenes": []}', encoding="utf-8")
            result = check(root, static_only=True, sync_scenes=True, strict=True)
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["scenes"], ["LossBowl", "ChainRule"])
        self.assertEqual([b["id"] for b in result["blocks"]], ["bowl", "setup", "chain", "links", "result"])


class TidyTest(unittest.TestCase):
    def test_keeps_the_traceback_and_drops_colour_and_progress_bars(self):
        noisy = (
            "\x1b[32mManimGL v1.7.2\x1b[0m\n"
            "Intro.mp4 0 WriteText : : 25it [00:00, 61.94it/s]\rIntro.mp4 1 Wait : : 44it [00:00, 80it/s]\n"
            "\n"
            "Traceback (most recent call last):\n"
            '  File "scenes.py", line 9, in construct\n'
            "NameError: name 'MathTex' is not defined\n"
        )
        self.assertEqual(
            tidy(noisy),
            "ManimGL v1.7.2\nTraceback (most recent call last):\n"
            '  File "scenes.py", line 9, in construct\n'
            "NameError: name 'MathTex' is not defined",
        )
        self.assertEqual(tidy("a\nb\nc\nd", limit=2), "c\nd")


class StoryboardFileTest(unittest.TestCase):
    """build/check/storyboard.json, from what each scene reported while it was checked."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "script.txt").write_text(SCRIPT, encoding="utf-8")
        (self.root / "scenes.py").write_text(SCENES, encoding="utf-8")
        self.config = {"script": "script.txt", "scenes_file": "scenes.py", "scenes": ["Intro", "Outro"]}
        self.manifest = {
            "order": ["intro", "outro"],
            "blocks": {
                "intro": {"wav": "audio/intro-1.wav", "duration": 2.5, "marks": {"slope": 1.1}, "text": "Every line has a slope."},
                "outro": {"wav": "audio/outro-2.wav", "duration": 1.25, "marks": {}, "text": "That is all."},
            },
        }

    def test_each_block_gets_its_narration_stills_and_problems(self):
        intro = {
            "blocks": [{"id": "intro", "start": 0.2, "duration": 2.5}],
            "stills": [
                {"block": "intro", "mark": "slope", "file": "Intro-intro--slope.png", "at": 1.1},
                {"block": "intro", "mark": None, "file": "Intro-intro.png", "at": 2.5},
                {"block": None, "mark": None, "file": "Intro-end.png", "at": None},
            ],
            "issues": [
                {"kind": "layout", "message": "text overlaps", "block": "intro", "scene": "Intro"},
                {"kind": "layout", "message": "off the edge in the last frame", "block": None, "scene": "Intro"},
            ],
        }
        board = write_storyboard(self.root, self.config, self.manifest, {"Intro": (intro, None), "Outro": (None, "NameError: Foo")})
        saved = json.loads((self.root / "build" / "check" / "storyboard.json").read_text())
        self.assertEqual(saved, board)
        first = board["scenes"][0]
        self.assertEqual(first["end"], "Intro-end.png")
        self.assertEqual(first["issues"], [{"kind": "layout", "message": "off the edge in the last frame"}])
        block = first["blocks"][0]
        self.assertEqual(block["text"], 'Every line has a <mark name="slope"/>slope.')
        self.assertEqual((block["start"], block["duration"], block["marks"]), (0.2, 2.5, {"slope": 1.1}))
        self.assertEqual([x["file"] for x in block["stills"]], ["Intro-intro--slope.png", "Intro-intro.png"])
        self.assertEqual(block["issues"], [{"kind": "layout", "message": "text overlaps"}])
        # A scene that failed before drawing anything still lists the blocks it would play.
        failed = board["scenes"][1]
        self.assertEqual(failed["error"], "NameError: Foo")
        self.assertEqual([b["id"] for b in failed["blocks"]], ["outro"])
        self.assertEqual(failed["blocks"][0]["stills"], [])
        self.assertEqual(board["unplayed"], [])
        self.assertEqual(board["duration"], 3.75)


if __name__ == "__main__":
    unittest.main()

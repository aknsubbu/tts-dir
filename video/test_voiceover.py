"""VoiceoverScene time arithmetic, against a fake scene clock. No GPU, manim or numpy needed."""
import json
import math
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from voiceover import VoiceoverError, VoiceoverScene


class FakeClock:
    """Advances time the way manimgl's Scene does.

    get_time_progression uses np.arange(0, run_time, 1/fps) + 1/fps: ceil(run_time * fps)
    frames, and the clock ends on the last of them, so every play or wait rounds up.
    """

    def _advance(self, run_time):
        step = 1 / self.camera.fps
        n = math.ceil(run_time / step)  # len(np.arange(0, run_time, step))
        if n:
            self.time += (n - 1) * step + step
            self.frames += n

    def play(self, run_time):
        self._advance(run_time)

    def wait(self, duration):
        self._advance(duration)

    def add_sound(self, path, time_offset=0):
        if not self.skip_animations:  # manimgl drops sounds while skipping
            self.sounds.append((Path(path).name, self.time + time_offset))


class FakeScene(VoiceoverScene, FakeClock):
    """VoiceoverScene first, as in class Intro(VoiceoverScene, Scene)."""

    def __init__(self, manifest, fps=30, skip_animations=False):
        self.time = 0.0
        self.camera = SimpleNamespace(fps=fps)
        self.skip_animations = skip_animations
        self.voiceover_manifest = manifest
        self.sounds = []
        self.frames = 0


def block(duration, marks=None, english=True):
    return {
        "wav": f"audio/{duration}.wav",
        "duration": duration,
        "words": [{"text": "w", "start": 0, "end": 0.1}] if english else [],
        "marks": marks or {},
    }


class VoiceoverTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.blocks = {
            "intro": block(3.517, {"slope": 1.23, "late": 2.9}),
            "many": block(10.0, {f"m{i}": round(0.137 * (i + 1) + i * 0.0613, 4) for i in range(40)}),
            "spanish": block(2.0, english=False),
        }
        (self.dir / "audio").mkdir()
        for b in self.blocks.values():
            (self.dir / b["wav"]).write_bytes(b"RIFF")
        self.manifest = self.dir / "manifest.json"
        self.manifest.write_text(json.dumps({"order": list(self.blocks), "blocks": self.blocks}))
        self.env = {k: os.environ.pop(k) for k in ("VOICEOVER_MANIFEST", "VOICEOVER_TIMELINE") if k in os.environ}

    def tearDown(self):
        os.environ.pop("VOICEOVER_TIMELINE", None)
        os.environ.pop("VOICEOVER_MANIFEST", None)
        os.environ.update(self.env)
        self.tmp.cleanup()

    def scene(self, **kw):
        return FakeScene(self.manifest, **kw)

    def test_sound_starts_at_entry_and_durations_aim_at_absolute_times(self):
        s = self.scene()
        s.wait(0.5)
        with s.voiceover("intro") as vo:
            self.assertEqual(s.sounds, [("3.517.wav", 0.5)])
            self.assertEqual(vo.start, 0.5)
            self.assertEqual(vo.duration, 3.517)
            self.assertAlmostEqual(vo.until("slope"), 1.23)
            s.play(run_time=vo.until("slope"))
            # Rounded up to a whole frame: at the mark, never more than a frame late.
            self.assertGreaterEqual(s.time, 0.5 + 1.23 - 1e-9)
            self.assertLess(s.time - (0.5 + 1.23), 1 / 30)
            # The next duration is measured from where the clock really is.
            self.assertAlmostEqual(vo.remaining(), 0.5 + 3.517 - s.time)
        # Leaving waits out the audio.
        self.assertGreaterEqual(s.time, 0.5 + 3.517 - 1e-9)
        self.assertLess(s.time - (0.5 + 3.517), 1 / 30)

    def test_rounding_never_accumulates_across_many_marks(self):
        for fps in (24, 30, 60):
            with self.subTest(fps=fps):
                s = self.scene(fps=fps)
                s.wait(0.123)
                with s.voiceover("many") as vo:
                    for i in range(40):
                        s.play(run_time=vo.until(f"m{i}"))
                        target = vo.start + vo.marks[f"m{i}"]
                        self.assertGreaterEqual(s.time, target - 1e-9)
                        self.assertLess(s.time - target, 1 / fps + 1e-9)
                    s.play(run_time=vo.remaining())
                self.assertLess(s.time - vo.end, 1 / fps + 1e-9)

                # Chaining relative durations instead would drift by up to a frame per step.
                naive = self.scene(fps=fps)
                naive.wait(0.123)
                prev = 0
                for i in range(40):
                    mark = vo.marks[f"m{i}"]
                    naive.play(run_time=mark - prev)
                    prev = mark
                self.assertGreater(naive.time - (0.123 + vo.marks["m39"]), 1 / fps)

    def test_leaving_early_waits_and_leaving_late_warns(self):
        s = self.scene()
        with s.voiceover("intro"):
            s.play(run_time=1)
        self.assertGreaterEqual(s.time, 3.517)

        s = self.scene()
        with self.assertLogs("manimgl", "WARNING") as logs:
            with s.voiceover("intro"):
                s.play(run_time=5)
        self.assertEqual(s.time, 5)  # no extra wait
        self.assertIn("1.48s past the end", logs.output[0])

    def test_a_mark_already_passed_gets_one_frame_and_a_warning(self):
        s = self.scene()
        with s.voiceover("intro") as vo:
            s.play(run_time=2)
            with self.assertLogs("manimgl", "WARNING") as logs:
                self.assertAlmostEqual(vo.until("slope"), 1 / 30)
            self.assertIn('0.77s past mark "slope"', logs.output[0])
            self.assertAlmostEqual(vo.until("late"), 0.9)

    def test_clear_errors_for_unknown_blocks_and_marks(self):
        s = self.scene()
        with self.assertRaisesRegex(VoiceoverError, 'No narration block "outro".*intro, many, spanish'):
            s.voiceover("outro")
        with s.voiceover("intro") as vo:
            with self.assertRaisesRegex(VoiceoverError, 'no mark "slop". Its marks: late, slope'):
                vo.until("slop")
        with s.voiceover("spanish") as vo:
            with self.assertRaisesRegex(VoiceoverError, "no word timing"):
                vo.until("anything")
            self.assertAlmostEqual(vo.remaining(), vo.end - s.time)

    def test_missing_manifest_or_audio_is_explained(self):
        s = FakeScene(None)
        with self.assertRaisesRegex(VoiceoverError, "No narration manifest"):
            s.voiceover("intro")
        s = FakeScene(self.dir / "nope.json")
        with self.assertRaisesRegex(VoiceoverError, "not found"):
            s.voiceover("intro")
        (self.dir / "audio" / "3.517.wav").unlink()
        with self.assertRaisesRegex(VoiceoverError, "is missing"):
            self.scene().voiceover("intro")

    def test_env_manifest_wins_over_the_class_attribute(self):
        os.environ["VOICEOVER_MANIFEST"] = str(self.manifest)
        s = FakeScene(self.dir / "nope.json")
        with s.voiceover("intro") as vo:
            self.assertEqual(vo.duration, 3.517)

    def test_blocks_cannot_nest(self):
        s = self.scene()
        with s.voiceover("intro"):
            with self.assertRaisesRegex(VoiceoverError, "cannot overlap"):
                with s.voiceover("many"):
                    pass

    def test_an_error_inside_a_block_is_not_hidden_by_a_wait(self):
        s = self.scene()
        with self.assertRaises(ZeroDivisionError):
            with s.voiceover("intro"):
                1 / 0
        self.assertEqual(s.time, 0)
        with s.voiceover("many"):  # and the next block still works
            pass

    def test_skipping_warns_that_audio_is_lost(self):
        s = self.scene(skip_animations=True)
        with self.assertLogs("manimgl", "WARNING") as logs:
            with s.voiceover("intro"):
                pass
        self.assertIn("Render in full", logs.output[0])
        self.assertEqual(s.sounds, [])

    def test_writes_block_start_times_for_captions(self):
        out = self.dir / "timeline" / "Intro.json"
        os.environ["VOICEOVER_TIMELINE"] = str(out)
        s = self.scene()
        s.wait(0.25)
        with s.voiceover("intro"):
            pass
        start = s.time
        with s.voiceover("spanish"):
            pass
        data = json.loads(out.read_text())
        self.assertEqual(data["scene"], "FakeScene")
        self.assertEqual(data["fps"], 30)
        self.assertEqual([b["id"] for b in data["blocks"]], ["intro", "spanish"])
        self.assertAlmostEqual(data["blocks"][0]["start"], 8 / 30, places=5)  # wait(0.25) is 8 frames
        self.assertAlmostEqual(data["blocks"][1]["start"], start, places=5)


class ReportTest(unittest.TestCase):
    """What a scene writes down for check.py when $VOICEOVER_REPORT is set."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        blocks = {"intro": block(3.0, {"early": 1.0, "late": 2.5})}
        (self.dir / "audio").mkdir()
        for b in blocks.values():
            (self.dir / b["wav"]).write_bytes(b"")
        (self.dir / "manifest.json").write_text(json.dumps({"order": list(blocks), "blocks": blocks}))
        self.report = self.dir / "report.json"
        os.environ["VOICEOVER_REPORT"] = str(self.report)
        self.scene = FakeScene(self.dir / "manifest.json", skip_animations=True)

    def tearDown(self):
        os.environ.pop("VOICEOVER_REPORT", None)
        self.tmp.cleanup()

    def issues(self):
        return [i["message"] for i in json.loads(self.report.read_text())["issues"]]

    def test_a_scene_in_time_reports_no_issues(self):
        with self.scene.voiceover("intro") as vo:
            self.scene.play(vo.until("early"))
            self.scene.play(vo.until("late"))
        data = json.loads(self.report.read_text())
        self.assertEqual(data["issues"], [])
        self.assertEqual([b["id"] for b in data["blocks"]], ["intro"])

    def test_running_past_a_mark_and_past_the_end_are_reported_once_each(self):
        with self.scene.voiceover("intro") as vo:
            self.scene.play(2.0)  # a fixed run time that overshoots "early" by a second
            vo.until("early")
            vo.until("early")
            self.scene.play(3.0)
        self.assertEqual(self.issues(), [
            'the animations before it ran 1.00s past mark "early" in "intro"',
            'the animations in block "intro" ran 2.00s past the end of its narration',
        ])

    def test_being_a_few_frames_late_is_not_worth_reporting(self):
        with self.scene.voiceover("intro") as vo:
            self.scene.play(1.2)
            vo.until("early")
            self.scene.play(vo.remaining() + 0.2)
        self.assertEqual(self.issues(), [])

    def test_nothing_is_written_without_the_report_variable(self):
        del os.environ["VOICEOVER_REPORT"]
        with self.scene.voiceover("intro") as vo:
            self.scene.play(5.0)
        self.assertFalse(self.report.exists())

    def test_problems_name_their_block_and_scene(self):
        with self.scene.voiceover("intro") as vo:
            self.scene.play(2.0)
            vo.until("early")
        issue = json.loads(self.report.read_text())["issues"][0]
        self.assertEqual((issue["block"], issue["scene"]), ("intro", "FakeScene"))


class PictureScene(FakeScene):
    """A fake that can draw: each picture records what was on screen when it was taken."""

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.screen = "empty"

    def update_frame(self, dt=0, force_draw=False):
        pass

    def get_image(self):
        shown = self.screen
        return SimpleNamespace(save=lambda path: Path(path).write_text(shown))


class StoryboardTest(unittest.TestCase):
    """Stills at every mark and at the end of every block, for the storyboard."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        blocks = {"intro": block(3.0, {"slope": 1.0, "rise": 2.0}), "outro": block(1.0)}
        (self.dir / "audio").mkdir()
        for b in blocks.values():
            (self.dir / b["wav"]).write_bytes(b"")
        (self.dir / "manifest.json").write_text(json.dumps({"order": list(blocks), "blocks": blocks}))
        self.shots = self.dir / "frames"
        os.environ["VOICEOVER_REPORT"] = str(self.dir / "report.json")
        os.environ["VOICEOVER_SNAPSHOTS"] = str(self.shots)
        self.scene = PictureScene(self.dir / "manifest.json", skip_animations=True)

    def tearDown(self):
        os.environ.pop("VOICEOVER_REPORT", None)
        os.environ.pop("VOICEOVER_SNAPSHOTS", None)
        self.tmp.cleanup()

    def stills(self):
        return json.loads((self.dir / "report.json").read_text())["stills"]

    def shown(self, file):
        return (self.shots / file).read_text()

    def test_an_animation_that_ends_on_a_mark_is_pictured_as_it_ends(self):
        s = self.scene
        with s.voiceover("intro") as vo:
            s.screen = "graph"
            s.play(vo.until("slope"))
            s.screen = "graph and line"
            s.play(vo.until("rise"))
            s.screen = "everything"
        stills = self.stills()
        self.assertEqual([(x["block"], x["mark"], x["at"]) for x in stills], [("intro", "slope", 1.0), ("intro", "rise", 2.0), ("intro", None, 3.0)])
        self.assertEqual(self.shown("PictureScene-intro--slope.png"), "graph")
        self.assertEqual(self.shown("PictureScene-intro--rise.png"), "graph and line")
        self.assertEqual(self.shown("PictureScene-intro.png"), "everything")

    def test_waiting_for_a_word_then_revealing_pictures_the_reveal(self):
        s = self.scene
        with s.voiceover("intro") as vo:
            s.wait(vo.until("slope"))
            s.screen = "caption"
            s.play(0.5)
            s.wait(vo.until("rise"))  # nothing is revealed for this one before the block ends
            s.screen = "end"
        self.assertEqual(self.shown("PictureScene-intro--slope.png"), "caption")
        self.assertEqual(self.shown("PictureScene-intro--rise.png"), "end")
        self.assertEqual([x["mark"] for x in self.stills()], ["slope", "rise", None])

    def test_no_pictures_without_the_snapshot_variable(self):
        del os.environ["VOICEOVER_SNAPSHOTS"]
        with self.scene.voiceover("intro") as vo:
            self.scene.play(vo.until("rise"))
        self.assertFalse(self.shots.exists())
        self.assertEqual(self.stills(), [])


if __name__ == "__main__":
    unittest.main()

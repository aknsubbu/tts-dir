"""Narrate pass tests. Standard library only: a fake synthesizer stands in for Kokoro."""
import json
import tempfile
import unittest
from pathlib import Path

from narrate import ScriptError, block_key, locate_words, narrate, parse_script, resolve_marks, strip_marks

# Real af_heart tokens for this sentence, as Kokoro returned them (the "$" had no timing).
REAL_TEXT = "In 1990, we didn't use well-known “curly quotes” — or $5.50 at 3:30pm. Dr. Smith's ratio is 0.5%!"
REAL_WORDS = [
    {"text": t, "start": a, "end": b}
    for t, a, b in [
        ("In", 0.275, 0.375), ("1990", 0.375, 1.3), (",", 1.3, 1.4), ("we", 1.4, 1.5), ("didn't", 1.5, 1.725),
        ("use", 1.725, 1.9625), ("well-known", 1.9625, 2.55), ("“", 2.55, 2.6), ("curly", 2.6, 2.925),
        ("quotes", 2.925, 3.6), ("”", 3.6, 3.7), ("—", 3.7, 3.775), ("or", 3.775, 3.9625),
        ("5.50", 3.9625, 5.5875), ("at", 5.5875, 5.7625), ("3:30pm", 5.7625, 7.675), (".", 7.675, 7.8375),
        ("Dr.", 7.8375, 8.25), ("Smith's", 8.25, 8.575), ("ratio", 8.575, 9.1375), ("is", 9.1375, 9.3125),
        ("0.5%", 9.3125, 11.0), ("!", 11.0, 11.15),
    ]
]


def words(*spec):
    return [{"text": t, "start": a, "end": b} for t, a, b in spec]


class ScriptTest(unittest.TestCase):
    def test_parses_blocks_comments_and_paragraphs(self):
        src = "# a comment\n[intro]\nFirst line\nsecond line.\n\n\n\nNew paragraph.\n\n[next-one]\n  Hi.  \n"
        self.assertEqual(
            parse_script(src),
            [("intro", "First line\nsecond line.\n\nNew paragraph."), ("next-one", "Hi.")],
        )

    def test_rejects_bad_scripts(self):
        for src, msg in [
            ("Hello\n[a]\nx", "before the first"),
            ("[a]\nx\n[a]\ny", "twice"),
            ("[a]\n\n[b]\ny", "no text"),
            ("# only a comment", "no \\[block-id\\]"),
        ]:
            with self.subTest(src=src):
                with self.assertRaisesRegex(ScriptError, msg):
                    parse_script(src)

    def test_strips_marks_and_records_offsets(self):
        text, marks = strip_marks('Every line has <mark name="s"/> a slope.<mark name=\'end\'/>')
        self.assertEqual(text, "Every line has a slope.")
        self.assertEqual(marks, {"s": text.index("a slope"), "end": len(text)})
        text, marks = strip_marks('<mark name="first"/>Go.')
        self.assertEqual((text, marks), ("Go.", {"first": 0}))

    def test_rejects_duplicate_marks_and_unknown_tags(self):
        with self.assertRaisesRegex(ScriptError, "twice"):
            strip_marks('<mark name="a"/>x <mark name="a"/>y')
        with self.assertRaisesRegex(ScriptError, "unknown tag"):
            strip_marks('Say <break time="1s"/> this.')
        with self.assertRaisesRegex(ScriptError, "unknown tag"):
            strip_marks("<mark/> nameless")


class MarkTest(unittest.TestCase):
    def test_real_tokens_all_line_up_with_the_text(self):
        positions = locate_words(REAL_TEXT, REAL_WORDS)
        self.assertNotIn(None, positions)
        for p, w in zip(positions, REAL_WORDS):
            self.assertEqual(REAL_TEXT[p:p + len(w["text"])], w["text"])

    def test_mark_resolves_to_the_next_word_even_across_punctuation(self):
        cases = {
            "In 1990,": 1.4,  # skips the comma token, lands on "we"
            "In 1990, we didn't use well-known ": 2.6,  # before the opening quote: lands on "curly"
            "In 1990, we didn't use well-known “curly quotes” — or $": 3.9625,  # untimed "$": next is 5.50
            "In 1990, we didn't use well-known “curly quotes” — or $5.50 at 3:30pm. ": 7.8375,
        }
        for prefix, expected in cases.items():
            with self.subTest(prefix=prefix):
                marks, warnings = resolve_marks(REAL_TEXT, {"m": len(prefix)}, REAL_WORDS)
                self.assertEqual(marks, {"m": expected})
                self.assertEqual(warnings, [])

    def test_mark_in_the_middle_of_a_repeated_word_is_not_confused(self):
        text = "go go go stop"
        ws = words(("go", 0.0, 0.2), ("go", 0.3, 0.5), ("go", 0.6, 0.8), ("stop", 0.9, 1.2))
        marks, _ = resolve_marks(text, {"third": text.index("go stop")}, ws)
        self.assertEqual(marks, {"third": 0.6})

    def test_mark_after_the_last_word_uses_the_end_of_speech(self):
        marks, warnings = resolve_marks("All done.", {"end": 9}, words(("All", 0.1, 0.3), ("done", 0.3, 0.7), (".", 0.7, 0.8)))
        self.assertEqual(marks, {"end": 0.8})
        self.assertIn("no word after it", warnings[0])

    def test_no_word_timing_falls_back_to_block_level(self):
        marks, warnings = resolve_marks("Hola amigos.", {"m": 5}, [])
        self.assertEqual(marks, {})
        self.assertIn("block-level", warnings[0])

    def test_unmatched_tokens_are_skipped_with_a_warning(self):
        ws = words(("one", 0.0, 0.2), ("UNSEEN", 0.2, 0.4), ("two", 0.4, 0.6))
        self.assertEqual(locate_words("one two", ws), [0, None, 4])
        marks, warnings = resolve_marks("one two", {"m": 4}, ws)
        self.assertEqual(marks, {"m": 0.4})
        self.assertIn("could not be matched", warnings[0])


class FakeKokoro:
    """Writes a placeholder file and pretends every word lasts 0.25 s."""

    def __init__(self):
        self.calls = []

    def __call__(self, text, out, voice, speed):
        self.calls.append((text, voice, speed))
        Path(out).write_bytes(b"RIFF fake")
        ws = [{"text": t, "start": i * 0.25, "end": i * 0.25 + 0.2} for i, t in enumerate(text.split())]
        return {"durationSec": len(ws) * 0.25 + 0.1, "words": ws}


class NarrateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "proj"
        self.root.mkdir()
        self.write(voice="af_heart", script='[intro]\nHello <mark name="w"/>world again.\n\n[outro]\nBye now.\n')

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, voice=None, speed=1.0, script=None):
        if voice:
            (self.root / "project.json").write_text(json.dumps({"voice": voice, "speed": speed}))
        if script:
            (self.root / "script.txt").write_text(script)

    def run_narrate(self, **kw):
        return narrate(self.root, self.fake, log=lambda m: None, **kw)

    def test_writes_manifest_with_relative_wavs_words_and_marks(self):
        self.fake = FakeKokoro()
        m = self.run_narrate()
        self.assertEqual(m["order"], ["intro", "outro"])
        intro = m["blocks"]["intro"]
        self.assertEqual(intro["text"], "Hello world again.")
        self.assertEqual(intro["marks"], {"w": 0.25})
        self.assertEqual(intro["duration"], 0.85)
        self.assertEqual(intro["wav"], f"audio/intro-{block_key('Hello world again.', 'af_heart', 1.0)}.wav")
        self.assertTrue((self.root / "build" / intro["wav"]).is_file())
        on_disk = json.loads((self.root / "build" / "manifest.json").read_text())
        self.assertEqual(on_disk, m)
        self.assertEqual(self.fake.calls[0], ("Hello world again.", "af_heart", 1.0))

    def test_only_changed_blocks_are_spoken_again_and_stale_audio_goes(self):
        self.fake = FakeKokoro()
        first = self.run_narrate()
        self.assertEqual(len(self.fake.calls), 2)

        self.fake = FakeKokoro()
        self.run_narrate()
        self.assertEqual(self.fake.calls, [])

        # Moving a mark changes no audio, so nothing is spoken, but the mark moves.
        self.write(script='[intro]\nHello world <mark name="w"/>again.\n\n[outro]\nBye now.\n')
        m = self.run_narrate()
        self.assertEqual(self.fake.calls, [])
        self.assertEqual(m["blocks"]["intro"]["marks"], {"w": 0.5})

        self.write(script='[intro]\nHello world again.\n\n[outro]\nBye for now.\n')
        m = self.run_narrate()
        self.assertEqual([c[0] for c in self.fake.calls], ["Bye for now."])
        files = sorted(p.name for p in (self.root / "build" / "audio").iterdir())
        self.assertNotIn(Path(first["blocks"]["outro"]["wav"]).name, files)
        self.assertEqual(len(files), 4)  # a wav and a json per block

        self.fake = FakeKokoro()
        self.write(voice="bm_george")
        self.run_narrate()
        self.assertEqual(len(self.fake.calls), 2)
        self.fake = FakeKokoro()
        self.write(voice="bm_george", speed=1.1)
        self.run_narrate()
        self.assertEqual(len(self.fake.calls), 2)
        self.fake = FakeKokoro()
        self.run_narrate(force=True)
        self.assertEqual(len(self.fake.calls), 2)

    def test_a_failed_block_leaves_no_partial_file(self):
        def broken(text, out, voice, speed):
            Path(out).write_bytes(b"half")
            raise RuntimeError("boom")

        self.fake = broken
        with self.assertRaises(RuntimeError):
            self.run_narrate()
        self.assertEqual(list((self.root / "build" / "audio").iterdir()), [])


if __name__ == "__main__":
    unittest.main()

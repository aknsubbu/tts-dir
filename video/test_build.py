"""Build and caption tests. Standard library only: nothing is rendered or spoken."""
import unittest

from build import caption_cues, concat_args, transcript
from captions import block_cues, group_cues, join_tokens, to_srt, to_vtt


def words(*spec):
    return [{"text": t, "start": a, "end": b} for t, a, b in spec]


class CaptionTest(unittest.TestCase):
    def test_punctuation_tokens_join_their_words(self):
        ws = words(
            ("In", 0.2, 0.3), ("1990", 0.3, 1.3), (",", 1.3, 1.4), ("“", 2.5, 2.6), ("curly", 2.6, 2.9),
            ("quotes", 2.9, 3.6), ("”", 3.6, 3.7), ("—", 3.7, 3.8), ("or", 3.8, 3.9), ('"', 4, 4.1),
            ("so", 4.1, 4.2), ('"', 4.2, 4.3), ("!", 4.3, 4.4),
        )
        self.assertEqual(
            [w[0] for w in join_tokens(ws)],
            ["In", "1990,", "“curly", "quotes”—", "or", '"so"!'],
        )
        self.assertEqual(join_tokens(ws)[2], ("“curly", 2.6, 2.9))  # timed from the word, not the quote

    def test_cues_break_at_sentences_gaps_and_length(self):
        ws = words(
            ("One", 0.0, 0.2), ("two", 0.2, 0.4), (".", 0.4, 0.45),
            ("Three", 0.5, 0.7), ("four", 1.5, 1.7),  # a long pause before "four"
        ) + [{"text": "word", "start": 2 + i * 0.2, "end": 2.15 + i * 0.2} for i in range(12)]
        cues = group_cues(ws, offset=10)
        self.assertEqual(cues[0], (10.0, 10.45, "One two."))
        self.assertEqual(cues[1], (10.5, 10.7, "Three"))
        self.assertEqual(cues[2][2].split()[0], "four")
        self.assertTrue(all(len(c[2]) <= 42 for c in cues))
        self.assertEqual(sum(len(c[2].split()) for c in cues), 16)

    def test_block_without_words_is_split_into_sentences_by_length(self):
        cues = block_cues("Hola amigos.\nBienvenidos todos.", 1.0, 3.0)
        self.assertEqual([c[2] for c in cues], ["Hola amigos.", "Bienvenidos todos."])
        self.assertEqual(cues[0][0], 1.0)
        self.assertAlmostEqual(cues[-1][1], 4.0)

    def test_srt_and_vtt_format_and_never_overlap(self):
        cues = [(3661.2345, 3662.5, "Later"), (0.0, 1.5, "First"), (1.2, 2.0, "Second")]
        self.assertEqual(
            to_srt(cues),
            "1\n00:00:00,000 --> 00:00:01,200\nFirst\n\n"
            "2\n00:00:01,200 --> 00:00:02,000\nSecond\n\n"
            "3\n01:01:01,234 --> 01:01:02,500\nLater\n\n",
        )
        self.assertTrue(to_vtt(cues).startswith("WEBVTT\n\n00:00:00.000 --> 00:00:01.200\nFirst\n\n"))


class BuildTest(unittest.TestCase):
    MANIFEST = {
        "order": ["a", "b", "es", "spare"],
        "blocks": {
            "a": {"text": "Hi there.", "duration": 1.0, "words": words(("Hi", 0.1, 0.3), ("there", 0.3, 0.6), (".", 0.6, 0.7))},
            "b": {"text": "Bye.", "duration": 0.8, "words": words(("Bye", 0.2, 0.5), (".", 0.5, 0.6))},
            "es": {"text": "Hola.", "duration": 1.0, "words": []},
            "spare": {"text": "Unused.", "duration": 1.0, "words": words(("Unused", 0, 1))},
        },
    }

    def test_captions_add_scene_offsets_and_block_starts(self):
        scenes = [
            (0.0, {"blocks": [{"id": "a", "start": 0.5}, {"id": "b", "start": 2.0}]}),
            (4.2, {"blocks": [{"id": "es", "start": 0.1}]}),
            (6.0, None),  # a scene with no narration
        ]
        cues, unused = caption_cues(self.MANIFEST, scenes)
        self.assertEqual(
            [(round(a, 3), round(b, 3), t) for a, b, t in cues],
            [(0.6, 1.2, "Hi there."), (2.2, 2.6, "Bye."), (4.3, 5.3, "Hola.")],
        )
        self.assertEqual(unused, ["spare"])

    def test_concat_pads_each_scene_audio_to_its_picture(self):
        args = concat_args([("a.mp4", 12.366667, True), ("b.mp4", 6.0, False)], "out.mp4")
        self.assertEqual(args[:8], ["ffmpeg", "-y", "-v", "error", "-i", "a.mp4", "-i", "b.mp4"])
        graph = args[args.index("-filter_complex") + 1].split(";")
        self.assertIn("[0:a:0]aresample=48000,", graph[1])
        self.assertIn("apad,atrim=end=12.366667", graph[1])
        self.assertTrue(graph[3].startswith("anullsrc=") and "atrim=end=6.000000" in graph[3])
        self.assertEqual(graph[-1], "[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]")
        self.assertEqual(args[-1], "out.mp4")


if __name__ == "__main__":
    unittest.main()


class TranscriptTest(unittest.TestCase):
    def test_words_are_timed_in_the_joined_video(self):
        manifest = {"blocks": {
            "intro": {"text": "Hello, world.", "duration": 2.0, "words": words(("Hello", 0.1, 0.5), (",", 0.5, 0.6), ("world", 0.7, 1.2), (".", 1.2, 1.3))},
            "outro": {"text": "Hola.", "duration": 1.0, "words": []},
        }, "order": ["intro", "outro"]}
        out = transcript(manifest, [("Intro", 0.0, {"blocks": [{"id": "intro", "start": 0.5}]}), ("Outro", 3.0, {"blocks": [{"id": "outro", "start": 0.0}]})])
        intro, outro = out["blocks"]
        self.assertEqual((intro["scene"], intro["start"], intro["end"]), ("Intro", 0.5, 2.5))
        self.assertEqual(intro["words"], [["Hello,", 0.6, 1.1], ["world.", 1.2, 1.8]])
        self.assertEqual((outro["start"], outro["words"], outro["text"]), (3.0, [], "Hola."))


class ChapterTest(unittest.TestCase):
    def test_markers_for_the_mp4_and_the_page(self):
        from build import chapters_vtt, ffmetadata
        chapters = [{"title": "One neuron", "start": 0, "end": 181.5}, {"title": "Two = layers; #2", "start": 181.5, "end": 400}]
        meta = ffmetadata(chapters)
        self.assertTrue(meta.startswith(";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=181500\ntitle=One neuron\n"))
        self.assertIn("title=Two \\= layers\; \\#2", meta)
        self.assertEqual(chapters_vtt(chapters[:1]), "WEBVTT\n\n00:00:00.000 --> 00:03:01.500\nOne neuron\n\n")

    def test_a_chapter_moves_to_where_it_starts(self):
        from build import shift_chapter
        words = {"blocks": [
            {"id": "a", "scene": "S", "start": 0.5, "end": 2.0, "text": "Hi there.", "words": [["Hi", 0.5, 0.8], ["there.", 0.9, 1.4]]},
            {"id": "b", "scene": "S", "start": 2.0, "end": 4.0, "text": "Hola.", "words": []},
        ]}
        blocks, cues = shift_chapter(words, "02-chain", 100.0)
        self.assertEqual((blocks[0]["chapter"], blocks[0]["start"], blocks[0]["words"][0]), ("02-chain", 100.5, ["Hi", 100.5, 100.8]))
        self.assertEqual(cues[0], (100.5, 101.4, "Hi there."))
        self.assertEqual(cues[1], (102.0, 104.0, "Hola."))


@unittest.skipUnless(__import__("shutil").which("ffmpeg") and __import__("shutil").which("ffprobe"), "needs ffmpeg")
class JoinChaptersTest(unittest.TestCase):
    def test_chapters_join_into_one_video_with_markers(self):
        import json
        import subprocess
        import tempfile
        from pathlib import Path
        from build import join_chapters
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "lesson"
            parts = []
            for n, (cid, secs) in enumerate([("01-one", 1.0), ("02-two", 1.5)], 1):
                clip = Path(tmp) / f"{cid}.mp4"
                subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"color=c=black:s=320x180:d={secs}", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                                "-t", str(secs), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(clip)], check=True)
                words = Path(tmp) / f"{cid}.words.json"
                words.write_text(json.dumps({"blocks": [{"id": "b", "scene": "S", "start": 0.1, "end": 0.9, "text": f"Part {n}.", "words": [["Part", 0.1, 0.4], [f"{n}.", 0.4, 0.8]]}]}))
                parts.append({"id": cid, "title": f"Chapter {n}", "video": clip, "words": words, "card": None})
            result = join_chapters(root, parts)
            self.assertAlmostEqual(result["duration"], 2.5, delta=0.1)
            self.assertEqual([c["start"] for c in result["chapters"]], [0.0, 1.0])
            probe = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_chapters", "-of", "json", str(root / "build" / "lesson.mp4")], capture_output=True, text=True, check=True).stdout)
            self.assertEqual([c["tags"]["title"] for c in probe["chapters"]], ["Chapter 1", "Chapter 2"])
            self.assertIn("00:00:01.100 --> ", (root / "build" / "lesson.vtt").read_text())
            words = json.loads((root / "build" / "lesson.words.json").read_text())
            self.assertEqual(words["blocks"][1]["words"][0], ["Part", 1.1, 1.4])
            self.assertIn("Chapter 2", (root / "build" / "lesson.chapters.vtt").read_text())

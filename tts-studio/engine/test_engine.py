"""Text handling and timing tests. They need only the standard library, not the model."""
import unittest
from types import SimpleNamespace

from kokoro_engine import LANGUAGES, LINE_PAUSE, PARAGRAPH_PAUSE, SAMPLE_RATE, clean, speak_segments, split_segments

SENTENCE = "This is a perfectly ordinary sentence about nothing in particular."


class CleanTest(unittest.TestCase):
    def test_strips_markdown_but_keeps_words_and_snake_case(self):
        md = (
            "# Title\n\nHello **bold** and _soft_ with [a link](http://x.com) and `code`.\n\n"
            "- item one\n- item two\n\n```js\nignore()\n```\n\nuse my_snake_case_name here"
        )
        self.assertEqual(
            clean(md),
            "Title\n\nHello bold and soft with a link and code.\n\nitem one\nitem two\n\nuse my_snake_case_name here",
        )

    def test_keeps_pronunciation_hints_but_strips_ordinary_links(self):
        self.assertEqual(
            clean("Say [Kokoro](/kˈOkəɹO/) on [this page](/docs/intro)."),
            "Say [Kokoro](/kˈOkəɹO/) on this page.",
        )

    def test_can_leave_markdown_alone(self):
        self.assertEqual(clean("**x**\r\n\r\n\r\n\r\ny", strip_markdown=False), "**x**\n\ny")


class SplitTest(unittest.TestCase):
    def test_short_text_is_one_segment_with_no_trailing_pause(self):
        self.assertEqual(split_segments("One short paragraph.", 400), [("One short paragraph.", 0.0)])

    def test_respects_the_limit_and_never_loses_words(self):
        text = " ".join([SENTENCE] * 200)
        for limit in sorted({lang["limit"] for lang in LANGUAGES.values()}):
            segments = split_segments(text, limit)
            self.assertGreater(len(segments), 1)
            self.assertTrue(all(len(s) <= limit for s, _ in segments))
            self.assertEqual(" ".join(s for s, _ in segments).split(), text.split())

    def test_paragraphs_get_a_longer_pause_than_lines(self):
        segments = split_segments("First paragraph.\n\nitem one\nitem two\n\nLast.", 400)
        self.assertEqual([s for s, _ in segments], ["First paragraph.", "item one", "item two", "Last."])
        self.assertEqual([p for _, p in segments], [PARAGRAPH_PAUSE, LINE_PAUSE, PARAGRAPH_PAUSE, 0.0])

    def test_hard_wrapped_prose_is_rejoined(self):
        wrapped = (
            "This paragraph was wrapped at a fixed column by an editor, so\n"
            "its lines end in the middle of sentences and must be rejoined."
        )
        self.assertEqual(len(split_segments(wrapped, 400)), 1)

    def test_huge_unpunctuated_run_is_split_at_spaces(self):
        text = " ".join(f"w{i}" for i in range(2000))
        segments = split_segments(text, 220)
        self.assertTrue(all(len(s) <= 220 for s, _ in segments))
        self.assertEqual(sum(len(s.split()) for s, _ in segments), 2000)

    def test_chinese_and_japanese_sentences_split_without_spaces(self):
        text = "你好。" * 100
        segments = split_segments(text, 80)
        self.assertTrue(all(len(s) <= 80 for s, _ in segments))
        self.assertEqual("".join(s.replace(" ", "") for s, _ in segments), text)


class FakeAudio(list):
    """Stands in for a torch tensor: .detach().cpu().numpy() gives back the samples."""

    def detach(self):
        return self

    def cpu(self):
        return self

    def numpy(self):
        return self


def result(seconds, tokens=(), phonemes="", audio=True):
    toks = None if tokens is None else [SimpleNamespace(text=t, start_ts=a, end_ts=b) for t, a, b in tokens]
    return SimpleNamespace(
        audio=FakeAudio([0.0] * int(seconds * SAMPLE_RATE)) if audio else None,
        tokens=toks,
        phonemes=phonemes,
    )


class FakePipeline:
    """Answers each segment with the results queued for it, in order."""

    def __init__(self, per_segment):
        self.per_segment = list(per_segment)
        self.calls = []

    def __call__(self, text, voice, speed, split_pattern):
        self.calls.append((text, voice, speed, split_pattern))
        return iter(self.per_segment.pop(0))


def run(per_segment, segments):
    written, padded = [], []
    pipe = FakePipeline(per_segment)
    samples, truncated, words = speak_segments(
        pipe, segments, "af_heart", 1.0, write=lambda a: written.append(len(a)), pad=padded.append
    )
    return samples, truncated, words, written, padded, pipe


class TimingTest(unittest.TestCase):
    def test_words_are_offset_by_earlier_results_and_pauses(self):
        segments = [("Hello there.", PARAGRAPH_PAUSE), ("Bye now.", 0.0)]
        per_segment = [
            # Kokoro can yield several results for one segment; each is timed from its own start.
            [result(1.0, [("Hello", 0.1, 0.5)]), result(0.5, [("there", 0.05, 0.4), (".", 0.4, 0.45)])],
            [result(0.8, [("Bye", 0.2, 0.4), ("now", 0.4, 0.7)])],
        ]
        samples, _, words, written, padded, _ = run(per_segment, segments)
        pause = int(PARAGRAPH_PAUSE * SAMPLE_RATE)
        self.assertEqual(padded, [pause])
        self.assertEqual(samples, sum(written) + pause)
        second = 1.0 + pause / SAMPLE_RATE + 0.5  # start of the second segment's audio
        self.assertEqual(
            words,
            [
                {"text": "Hello", "start": 0.1, "end": 0.5},
                {"text": "there", "start": 1.05, "end": 1.4},
                {"text": ".", "start": 1.4, "end": 1.45},
                {"text": "Bye", "start": round(second + 0.2, 4), "end": round(second + 0.4, 4)},
                {"text": "now", "start": round(second + 0.4, 4), "end": round(second + 0.7, 4)},
            ],
        )

    def test_untimed_tokens_and_silent_results_are_skipped(self):
        per_segment = [[
            result(0.4, [("ignored", 0.0, 0.1)], audio=False),  # no audio: its tokens never play
            result(1.0, [("$", None, None), ("5", 0.1, 0.6)]),
        ]]
        samples, _, words, written, padded, _ = run(per_segment, [("$5", 0.0)])
        self.assertEqual(words, [{"text": "5", "start": 0.1, "end": 0.6}])
        self.assertEqual(written, [SAMPLE_RATE])
        self.assertEqual(padded, [])
        self.assertEqual(samples, SAMPLE_RATE)

    def test_missing_tokens_give_no_words_but_still_audio(self):
        # A Spanish voice returns tokens=None: audio is fine, word timing is not available.
        per_segment = [[result(1.0, None)], [result(0.5, None)]]
        samples, _, words, _, padded, _ = run(per_segment, [("Hola.", LINE_PAUSE), ("Adiós.", 0.0)])
        self.assertEqual(words, [])
        self.assertEqual(samples, int(1.5 * SAMPLE_RATE) + int(LINE_PAUSE * SAMPLE_RATE))
        self.assertEqual(padded, [int(LINE_PAUSE * SAMPLE_RATE)])

    def test_no_pause_before_any_audio_and_progress_per_segment(self):
        progress = []
        pipe = FakePipeline([[result(0, audio=False)], [result(0.5, [("hi", 0.0, 0.3)])]])
        padded = []
        samples, _, words = speak_segments(
            pipe, [("", LINE_PAUSE), ("hi", 0.0)], "af_heart", 1.2,
            write=lambda a: None, pad=padded.append, on_progress=lambda d, t: progress.append((d, t)),
        )
        self.assertEqual(padded, [])  # a pause with nothing before it would shift every word
        self.assertEqual(words[0]["start"], 0.0)
        self.assertEqual(progress, [(1, 2), (2, 2)])
        self.assertEqual(pipe.calls[1], ("hi", "af_heart", 1.2, None))

    def test_counts_segments_that_hit_the_phoneme_limit(self):
        _, truncated, _, _, _, _ = run([[result(0.1, phonemes="x" * 600), result(0.1, phonemes="x")]], [("t", 0.0)])
        self.assertEqual(truncated, 1)


if __name__ == "__main__":
    unittest.main()

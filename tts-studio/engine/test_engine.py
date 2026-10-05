"""Text handling tests. They need only the standard library, not the model."""
import unittest

from kokoro_engine import LANGUAGES, LINE_PAUSE, PARAGRAPH_PAUSE, clean, split_segments

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


if __name__ == "__main__":
    unittest.main()

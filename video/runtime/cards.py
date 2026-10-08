"""The title card shown before each chapter of a long lesson. build.py renders it with manimgl;
the writer never sees it. Its text comes from TITLE_CARD_NUMBER and TITLE_CARD_TITLE."""
import os

from manimlib import DOWN, GREY_B, UP, FadeIn, FadeOut, Scene, Text, VGroup


class TitleCard(Scene):
    def construct(self):
        number = Text(os.environ.get("TITLE_CARD_NUMBER", ""), font_size=32, color=GREY_B)
        title = Text(os.environ.get("TITLE_CARD_TITLE", ""), font_size=56)
        title.set_max_width(12)
        card = VGroup(number, title).arrange(DOWN, buff=0.4)
        self.play(FadeIn(card, shift=UP * 0.2), run_time=0.6)
        self.wait(1.6)
        self.play(FadeOut(card), run_time=0.4)

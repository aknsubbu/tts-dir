"""Demo: two short narrated scenes. Build with `python3 build.py demo` from video/.

Text() only, so no LaTeX is needed.
"""
import sys
from pathlib import Path

from manimlib import *
from manimlib.logger import log

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "runtime"))  # video/runtime/, for voiceover.py
from voiceover import VoiceoverScene

MANIFEST = Path(__file__).resolve().parent / "build" / "manifest.json"


class Slope(VoiceoverScene, Scene):
    voiceover_manifest = MANIFEST  # build.py also passes it in; this lets `manimgl scenes.py Slope -w` work alone

    def construct(self):
        title = Text("Slope", font_size=72).to_edge(UP)
        line = Line([-5, -2.5, 0], [5, 2.5, 0]).set_stroke(BLUE, 6)
        a, b = line.point_from_proportion(0.3), line.point_from_proportion(0.7)
        corner = [b[0], a[1], 0]
        run = Line(a, corner).set_stroke(YELLOW, 5)
        rise = Line(corner, b).set_stroke(RED, 5)
        rise_label = Text("rise", font_size=40).set_color(RED).next_to(rise, RIGHT)
        run_label = Text("run", font_size=40).set_color(YELLOW).next_to(run, DOWN)

        with self.voiceover("slope") as vo:
            self.play(Write(title), run_time=vo.until("slope"))
            self.play(ShowCreation(line), run_time=vo.until("rise"))
            self.play(ShowCreation(rise), FadeIn(rise_label), run_time=vo.until("run"))
            self.play(ShowCreation(run), FadeIn(run_label), run_time=vo.remaining())

        ratio = Text("slope = rise / run", font_size=56).to_edge(DOWN)
        with self.voiceover("slope-ratio") as vo:
            self.play(Write(ratio), run_time=vo.remaining() * 0.6)
            self.play(Indicate(rise), Indicate(run))
        self.wait(0.5)


class SyncCheck(VoiceoverScene, Scene):
    """Turns the square yellow on the frame where the bookmarked word starts.

    The square's first yellow frame should line up with the start of "now".
    `python3 projects/demo/check_sync.py` measures it in the built video.
    """

    voiceover_manifest = MANIFEST

    def construct(self):
        label = Text("Sync check", font_size=48).to_edge(UP)
        square = Square(side_length=3).set_stroke(WHITE, 6).set_fill(YELLOW, opacity=0)
        self.add(label)
        with self.voiceover("sync") as vo:
            self.play(FadeIn(square), run_time=0.5)
            self.wait(vo.until("flash"))
            # manim draws a frame after advancing its clock, so the next frame drawn
            # shows scene time self.time + 1/fps at video time self.time: on the word.
            fps = self.camera.fps
            log.info(
                f"SyncCheck: mark 'flash' at scene time {vo.time_of('flash'):.3f}s; "
                f"first yellow frame is frame {round(self.time * fps)} of this scene ({self.time:.3f}s)"
            )
            square.set_fill(YELLOW, opacity=1)
            self.wait(0.4)
            square.set_fill(YELLOW, opacity=0)
        self.wait(0.5)

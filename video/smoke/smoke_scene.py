from manimlib import *


class SmokeText(Scene):
    def construct(self):
        title = Text("Headless render check", font_size=60)
        circle = Circle(radius=1.5).set_stroke(BLUE, 6)
        square = Square(side_length=3).set_stroke(YELLOW, 6)
        self.play(Write(title))
        self.play(title.animate.to_edge(UP))
        self.play(ShowCreation(circle))
        self.play(Transform(circle, square))
        self.wait()


class SmokeTex(Scene):
    def construct(self):
        eq = Tex(R"e^{i\pi} + 1 = 0", font_size=96)
        self.play(Write(eq))
        self.wait()


class SmokeAudio(Scene):
    def construct(self):
        self.wait(0.5)
        self.add_sound(str(Path(__file__).parent / "out" / "line.wav"))
        self.play(Write(Text("Audio starts at 0.5s")), run_time=2)
        self.wait(2)

from manimlib import *
from voiceover import VoiceoverScene

# One colour per symbol, used in every equation of the video. There is no entry for the
# plain target y: a "y" key would also recolour the y inside \hat{y}.
COLORS = {"w": BLUE, "x": GREEN, R"\hat{y}": YELLOW, R"\eta": ORANGE}


class LossBowl(VoiceoverScene, Scene):
    def construct(self):
        axes = Axes((-1, 5, 1), (0, 5, 1), width=7, height=4.5).to_edge(LEFT, buff=1)
        w_label = Tex("w", font_size=44, t2c=COLORS).next_to(axes.x_axis, RIGHT, buff=0.2)
        l_label = Tex("L", font_size=44).next_to(axes.y_axis, UP, buff=0.2)
        graph = axes.get_graph(lambda w: 0.5 * (w - 2) ** 2, x_range=(-1, 5)).set_stroke(WHITE, 4)

        w0 = 4.2
        dot = Dot(axes.i2gp(w0, graph)).set_fill(BLUE)
        slope = w0 - 2
        direction = np.array([axes.x_axis.get_unit_size(), slope * axes.y_axis.get_unit_size(), 0])
        direction = direction / np.linalg.norm(direction)
        tangent = Line(dot.get_center() - 1.3 * direction, dot.get_center() + 1.3 * direction).set_stroke(YELLOW, 4)
        downhill = Arrow(dot.get_center() + 0.4 * UP, dot.get_center() + 0.4 * UP + 1.5 * LEFT, buff=0).set_color(YELLOW)

        question = Tex(R"\frac{\partial L}{\partial w} = \;?", font_size=64, t2c=COLORS)
        question.to_edge(RIGHT, buff=1.2)

        with self.voiceover("bowl") as vo:
            self.play(ShowCreation(axes), FadeIn(w_label), FadeIn(l_label), run_time=1.5)
            self.wait(vo.until("bowl"))
            self.play(ShowCreation(graph), run_time=1.2)
            self.play(FadeIn(dot, scale=0.5), run_time=0.6)
            self.wait(vo.until("down"))
            self.play(ShowCreation(tangent), GrowArrow(downhill), run_time=1)
            self.play(Write(question), run_time=1.2)


class ChainRule(VoiceoverScene, Scene):
    def construct(self):
        title = Text("Gradient of the squared error", font_size=44).to_edge(UP, buff=0.5)

        # The derivation is a column of lines. Lay all of it out first, then reveal it line by line.
        prediction = Tex(R"\hat{y} = w x", font_size=48, t2c=COLORS)
        loss = Tex(R"L = \tfrac{1}{2} (\hat{y} - y)^2", font_size=48, t2c=COLORS)
        setup = VGroup(prediction, loss).arrange(RIGHT, buff=1.5).next_to(title, DOWN, buff=0.6)

        chain = Tex(
            R"\frac{\partial L}{\partial w} = \frac{\partial L}{\partial \hat{y}} \cdot \frac{\partial \hat{y}}{\partial w}",
            font_size=52, t2c=COLORS,
        )
        chain.next_to(setup, DOWN, buff=0.8)
        first = chain[R"\frac{\partial L}{\partial \hat{y}}"][0]
        second = chain[R"\frac{\partial \hat{y}}{\partial w}"][0]

        value_1 = Tex(R"(\hat{y} - y)", font_size=44, t2c=COLORS)
        value_2 = Tex("x", font_size=44, t2c=COLORS)
        brace_1 = Brace(first, DOWN)
        brace_2 = Brace(second, DOWN)
        value_1.next_to(brace_1, DOWN, buff=0.15)
        value_2.next_to(brace_2, DOWN, buff=0.15)

        with self.voiceover("setup") as vo:
            self.play(FadeIn(title), run_time=0.8)
            self.wait(vo.until("pred"))
            self.play(Write(prediction), run_time=1.2)
            self.wait(vo.until("loss"))
            self.play(Write(loss), run_time=1.5)

        with self.voiceover("chain") as vo:
            # While the voice says where w hides, point at it.
            self.play(FlashAround(prediction["w"]), run_time=1.5)
            self.wait(vo.until("split"))
            self.play(Write(chain[R"\frac{\partial L}{\partial w} ="]), run_time=1)
            self.wait(vo.until("first"))
            self.play(FadeIn(first, shift=UP), run_time=0.8)
            self.wait(vo.until("second"))
            self.play(FadeIn(chain[R"\cdot"]), FadeIn(second, shift=UP), run_time=0.8)

        with self.voiceover("links") as vo:
            self.play(GrowFromCenter(brace_1), run_time=0.6)
            self.wait(vo.until("error"))
            # Carry the term down from the line it comes from, so the eye sees why.
            self.play(TransformFromCopy(loss[R"(\hat{y} - y)"][0], value_1), run_time=1)
            self.wait(vo.until("input"))
            self.play(GrowFromCenter(brace_2), TransformFromCopy(prediction["x"][0], value_2), run_time=1)

        gradient = Tex(R"\frac{\partial L}{\partial w} = (\hat{y} - y) \, x", font_size=56, t2c=COLORS)
        update = Tex(R"w \leftarrow w - \eta \, (\hat{y} - y) \, x", font_size=48, t2c=COLORS)
        VGroup(gradient, update).arrange(DOWN, buff=0.6).next_to(setup, DOWN, buff=0.9)
        box = SurroundingRectangle(gradient, buff=0.25).set_stroke(YELLOW, 3)
        working = VGroup(chain, brace_1, brace_2, value_1, value_2)

        with self.voiceover("result") as vo:
            self.wait(vo.until("grad"))
            # The working is replaced by its result: old lines go before new ones arrive.
            self.play(FadeOut(working), run_time=0.5)
            self.play(Write(gradient), run_time=1)
            self.play(ShowCreation(box), run_time=0.6)
            self.wait(vo.until("step"))
            self.play(FadeIn(update, shift=UP), run_time=1)
        self.wait(1)

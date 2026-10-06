from manimlib import *
from voiceover import VoiceoverScene

# One colour per symbol for the whole video. No key for the plain label y (it would
# also recolour the y inside \hat{y}) and none for x.
COLORS = {R"\hat{y}": YELLOW, "w": BLUE, "z": TEAL}


def strike(mob):
    """A diagonal red line through a mobject, to show it cancelling."""
    return Line(mob.get_corner(DL), mob.get_corner(UR)).set_stroke(RED, 5)


def bottom_part(mob, frac=0.44):
    """An invisible rectangle covering the denominator of a fraction mobject."""
    rect = Rectangle(width=mob.get_width(), height=mob.get_height() * frac)
    rect.move_to(mob.get_bottom(), DOWN)
    rect.set_stroke(WHITE, 0, opacity=0)
    return rect


class Puzzle(VoiceoverScene, Scene):
    def construct(self):
        axes = Axes((-6, 6, 2), (0, 1, 0.5), width=5.5, height=2.6)
        axes.to_edge(LEFT, buff=1.2).to_edge(UP, buff=1.3)
        z_label = Tex("z", font_size=40, t2c=COLORS).next_to(axes.x_axis, RIGHT, buff=0.2)
        yhat_label = Tex(R"\hat{y}", font_size=40, t2c=COLORS).next_to(axes.y_axis, UP, buff=0.15)
        one_line = DashedLine(axes.c2p(-6, 1), axes.c2p(6, 1)).set_stroke(GREY, 2)
        one_label = Tex("1", font_size=30).next_to(one_line, LEFT, buff=0.15)
        graph = axes.get_graph(lambda v: 1 / (1 + np.exp(-v)), x_range=(-6, 6)).set_stroke(YELLOW, 4)

        t = ValueTracker(-4)
        dot = Dot().set_fill(TEAL)
        dot.add_updater(lambda m: m.move_to(axes.i2gp(t.get_value(), graph)))

        z_eq = Tex(R"z = w^\top x + b", font_size=44, t2c=COLORS)
        yhat_eq = Tex(R"\hat{y} = \sigma(z) = \frac{1}{1 + e^{-z}}", font_size=44, t2c=COLORS)
        model = VGroup(z_eq, yhat_eq).arrange(DOWN, buff=0.5, aligned_edge=LEFT)
        model.to_edge(RIGHT, buff=0.9)
        model.set_y(axes.get_center()[1])

        loss = Tex(
            R"L = -\big[\, y \log \hat{y} + (1 - y) \log(1 - \hat{y}) \,\big]",
            font_size=44, t2c=COLORS,
        )
        note = Tex(R"y \in \{0, 1\}", font_size=36).set_color(GREY_A)
        loss_row = VGroup(loss, note).arrange(RIGHT, buff=0.7)
        loss_row.set_width(min(loss_row.get_width(), 12))
        loss_row.move_to(DOWN * 1.0)

        dest = Tex(R"\frac{\partial L}{\partial w} = (\hat{y} - y)\, x", font_size=52, t2c=COLORS)
        why = Text("Why so simple?", font_size=36).set_color(GREY_A)
        dest_row = VGroup(dest, why).arrange(RIGHT, buff=0.9).move_to(DOWN * 2.6)

        with self.voiceover("model") as vo:
            self.play(ShowCreation(axes), FadeIn(z_label), FadeIn(yhat_label), run_time=1.2)
            self.wait(vo.until("z"))
            self.play(Write(z_eq), run_time=1.2)
            self.wait(vo.until("sig"))
            self.play(ShowCreation(graph), FadeIn(one_line), FadeIn(one_label), run_time=1.0)
            self.play(Write(yhat_eq), FadeIn(dot), run_time=1.0)
            self.play(t.animate.set_value(3), run_time=max(vo.remaining(), 0.4))

        with self.voiceover("loss") as vo:
            self.play(Write(loss), run_time=1.5)
            self.wait(vo.until("label"))
            self.play(FadeIn(note, shift=LEFT), run_time=0.8)
            self.wait(vo.until("logs"))
            self.play(FlashAround(loss), run_time=1.2)

        with self.voiceover("puzzle") as vo:
            self.play(t.animate.set_value(-2), run_time=1.5)
            self.wait(vo.until("dest"))
            self.play(Write(dest), run_time=1.2)
            self.wait(vo.until("why"))
            self.play(FadeIn(why, shift=LEFT), run_time=0.7)
        self.wait(0.3)


class Chain(VoiceoverScene, Scene):
    def construct(self):
        flow = Tex(R"w \;\to\; z \;\to\; \hat{y} \;\to\; L", font_size=56, t2c=COLORS)
        flow.move_to(DOWN * 1.5)

        chain = Tex(
            R"\frac{\partial L}{\partial w} = \frac{\partial L}{\partial \hat{y}} \cdot \frac{\partial \hat{y}}{\partial z} \cdot \frac{\partial z}{\partial w}",
            font_size=48, t2c=COLORS,
        )
        chain.to_edge(UP, buff=0.5)
        first = chain[R"\frac{\partial L}{\partial \hat{y}}"][0]
        second = chain[R"\frac{\partial \hat{y}}{\partial z}"][0]
        third = chain[R"\frac{\partial z}{\partial w}"][0]

        brace_3 = Brace(third, DOWN)
        label_3 = Tex("x", font_size=40).next_to(brace_3, DOWN, buff=0.15)
        brace_12 = Brace(VGroup(first, second), DOWN)
        label_12 = Tex(R"\frac{\partial L}{\partial z}", font_size=38, t2c=COLORS)
        label_12.next_to(brace_12, DOWN, buff=0.15)

        # Link lines are built from separate pieces so each piece can be highlighted.
        l1_lhs = Tex(R"\frac{\partial L}{\partial \hat{y}} =", font_size=44, t2c=COLORS)
        l1_a = Tex(R"-\frac{y}{\hat{y}}", font_size=44, t2c=COLORS)
        l1_plus = Tex("+", font_size=44)
        l1_b = Tex(R"\frac{1 - y}{1 - \hat{y}}", font_size=44, t2c=COLORS)
        l1 = VGroup(l1_lhs, l1_a, l1_plus, l1_b).arrange(RIGHT, buff=0.25)

        l2_lhs = Tex(R"\frac{\partial \hat{y}}{\partial z} =", font_size=44, t2c=COLORS)
        l2_a = Tex(R"\hat{y}", font_size=44, t2c=COLORS)
        l2_b = Tex(R"(1 - \hat{y})", font_size=44, t2c=COLORS)
        l2 = VGroup(l2_lhs, l2_a, l2_b).arrange(RIGHT, buff=0.25)

        links = VGroup(l1, l2).arrange(DOWN, buff=0.6, aligned_edge=LEFT)
        links.move_to(DOWN * 1.6)

        den_a = l1_a[R"\hat{y}"][0]
        den_b = bottom_part(l1_b)
        rect_a1 = SurroundingRectangle(den_a, buff=0.07).set_stroke(GREEN, 3)
        rect_a2 = SurroundingRectangle(l2_a, buff=0.07).set_stroke(GREEN, 3)
        rect_b1 = SurroundingRectangle(den_b, buff=0.05).set_stroke(PINK, 3)
        rect_b2 = SurroundingRectangle(l2_b, buff=0.07).set_stroke(PINK, 3)

        with self.voiceover("chain") as vo:
            self.play(Write(flow), run_time=1.5)
            self.wait(vo.until("three"))
            self.play(Write(chain), run_time=1.2)
            self.wait(vo.until("easy"))
            self.play(GrowFromCenter(brace_3), FadeIn(label_3, shift=DOWN), run_time=0.8)
            self.wait(vo.until("two"))
            self.play(GrowFromCenter(brace_12), FadeIn(label_12, shift=DOWN), run_time=1.0)

        with self.voiceover("link1") as vo:
            self.play(FadeOut(flow), run_time=0.5)
            self.play(FlashAround(first), run_time=1.0)
            self.play(Write(l1_lhs), run_time=0.8)
            self.wait(vo.until("fracs"))
            self.play(Write(l1_a), run_time=0.8)
            self.play(Write(l1_plus), Write(l1_b), run_time=0.9)

        with self.voiceover("link2") as vo:
            self.play(FlashAround(second), run_time=1.0)
            self.play(Write(l2_lhs), run_time=0.8)
            self.wait(vo.until("deriv"))
            self.play(Write(l2_a), Write(l2_b), run_time=1.0)
            self.wait(vo.until("match"))
            self.play(ShowCreation(rect_a1), ShowCreation(rect_a2), run_time=0.7)
            self.play(ShowCreation(rect_b1), ShowCreation(rect_b2), run_time=0.7)
        self.wait(0.3)


class Collapse(VoiceoverScene, Scene):
    def construct(self):
        fs = 46
        p_lhs = Tex(R"\frac{\partial L}{\partial z} =", font_size=fs, t2c=COLORS)
        p_open = Tex(R"\bigg(", font_size=fs)
        p_a = Tex(R"-\frac{y}{\hat{y}}", font_size=fs, t2c=COLORS)
        p_plus = Tex("+", font_size=fs)
        p_b = Tex(R"\frac{1 - y}{1 - \hat{y}}", font_size=fs, t2c=COLORS)
        p_close = Tex(R"\bigg)", font_size=fs)
        p_fa = Tex(R"\hat{y}", font_size=fs, t2c=COLORS)
        p_fb = Tex(R"(1 - \hat{y})", font_size=fs, t2c=COLORS)
        line1 = VGroup(p_lhs, p_open, p_a, p_plus, p_b, p_close, p_fa, p_fb).arrange(RIGHT, buff=0.2)
        line1.to_edge(UP, buff=0.5)

        q_eq = Tex("=", font_size=fs)
        q_a = Tex(R"-\,y\,(1 - \hat{y})", font_size=fs, t2c=COLORS)
        q_b = Tex(R"+\;(1 - y)\,\hat{y}", font_size=fs, t2c=COLORS)
        line2 = VGroup(q_eq, q_a, q_b).arrange(RIGHT, buff=0.3)
        line2.next_to(line1, DOWN, buff=0.6)
        line2.shift((p_lhs.get_right()[0] - q_eq.get_right()[0]) * RIGHT)

        r_eq = Tex("=", font_size=fs)
        r1 = Tex(R"-\,y", font_size=fs)
        r2 = Tex(R"+\;y\,\hat{y}", font_size=fs, t2c=COLORS)
        r3 = Tex(R"+\;\hat{y}", font_size=fs, t2c=COLORS)
        r4 = Tex(R"-\;y\,\hat{y}", font_size=fs, t2c=COLORS)
        line3 = VGroup(r_eq, r1, r2, r3, r4).arrange(RIGHT, buff=0.3)
        line3.next_to(line2, DOWN, buff=0.6)
        line3.shift((p_lhs.get_right()[0] - r_eq.get_right()[0]) * RIGHT)

        result = Tex(R"\frac{\partial L}{\partial z} = \hat{y} - y", font_size=52, t2c=COLORS)
        result.next_to(line3, DOWN, buff=0.8).set_x(0)
        box = SurroundingRectangle(result, buff=0.25).set_stroke(YELLOW, 3)

        den_a = p_a[R"\hat{y}"][0]
        den_b = bottom_part(p_b)
        strikes_a = VGroup(strike(den_a), strike(p_fa))
        strikes_b = VGroup(strike(den_b), strike(p_fb))
        strikes_r = VGroup(strike(r2), strike(r4))

        with self.voiceover("term1") as vo:
            self.play(FadeIn(line1, shift=DOWN * 0.3), run_time=1.2)
            self.wait(vo.until("cancel"))
            self.play(ShowCreation(strikes_a[0]), ShowCreation(strikes_a[1]), run_time=0.7)
            self.wait(vo.until("left"))
            self.play(FadeIn(q_eq), Write(q_a), run_time=1.0)

        with self.voiceover("term2") as vo:
            self.play(FadeOut(strikes_a), run_time=0.5)
            self.wait(vo.until("cancel"))
            self.play(ShowCreation(strikes_b[0]), ShowCreation(strikes_b[1]), run_time=0.7)
            self.wait(vo.until("left"))
            self.play(Write(q_b), run_time=1.0)

        with self.voiceover("expand") as vo:
            self.play(FadeOut(strikes_b), line1.animate.set_opacity(0.4), run_time=0.6)
            self.wait(vo.until("four"))
            self.play(Write(line3), run_time=1.2)
            self.wait(vo.until("kill"))
            self.play(ShowCreation(strikes_r[0]), ShowCreation(strikes_r[1]), run_time=0.7)
            self.wait(vo.until("result"))
            self.play(Write(result), run_time=1.0)
            self.play(ShowCreation(box), run_time=0.6)
        self.wait(0.3)


class Result(VoiceoverScene, Scene):
    def construct(self):
        res = Tex(R"\frac{\partial L}{\partial z} = \hat{y} - y", font_size=48, t2c=COLORS)
        res.to_edge(UP, buff=0.5)

        given = Tex(R"y = 1, \quad \hat{y} = 0.8", font_size=42, t2c=COLORS)
        given.next_to(res, DOWN, buff=0.7)

        c_a = Tex(R"-\frac{1}{0.8}", font_size=46)
        c_times = Tex(R"\times", font_size=46)
        c_b = Tex(R"(0.8 \times 0.2)", font_size=46)
        c_eq = Tex(R"= -0.2", font_size=46)
        calc = VGroup(c_a, c_times, c_b, c_eq).arrange(RIGHT, buff=0.25)
        calc.move_to(DOWN * 0.2)

        cmp = Tex(R"\hat{y} - y = 0.8 - 1 = -0.2", font_size=46, t2c=COLORS)
        cmp.move_to(DOWN * 1.9)

        grad = Tex(R"\frac{\partial L}{\partial w} = (\hat{y} - y)\, x", font_size=60, t2c=COLORS)
        grad.move_to(UP * 0.5)
        box = SurroundingRectangle(grad, buff=0.25).set_stroke(YELLOW, 3)
        bias = Tex(R"\frac{\partial L}{\partial b} = \hat{y} - y", font_size=44, t2c=COLORS)
        bias.next_to(box, DOWN, buff=0.5)
        caption = Text("The sigmoid's slope cancels the log's fractions", font_size=32)
        caption.set_color(GREY_A)
        caption.set_width(min(caption.get_width(), 11))
        caption.to_edge(DOWN, buff=0.5)

        with self.voiceover("check") as vo:
            self.play(FadeIn(res), run_time=0.6)
            self.play(Write(given), run_time=1.0)
            self.wait(vo.until("a"))
            self.play(Write(c_a), run_time=0.7)
            self.wait(vo.until("b"))
            self.play(Write(c_times), Write(c_b), run_time=0.7)
            self.wait(vo.until("c"))
            self.play(Write(c_eq), run_time=0.7)
            self.play(FadeIn(cmp, shift=UP), run_time=0.8)

        with self.voiceover("final") as vo:
            self.play(FadeOut(VGroup(given, calc, cmp)), res.animate.set_opacity(0.5), run_time=0.6)
            self.wait(vo.until("grad"))
            self.play(Write(grad), run_time=1.0)
            self.play(ShowCreation(box), run_time=0.6)
            self.wait(vo.until("bias"))
            self.play(FadeIn(bias, shift=UP), run_time=0.8)
            self.wait(vo.until("pieces"))
            self.play(FadeIn(caption, shift=UP), run_time=0.8)
        self.wait(1)

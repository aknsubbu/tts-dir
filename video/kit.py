"""A small kit for lesson scenes: the layouts most mathematics lessons need, written once.

    from kit import derivation, boxed, cancel, plot, note

    steps = derivation(r"L = \\tfrac12(\\hat y - y)^2", r"\\frac{\\partial L}{\\partial \\hat y} = \\hat y - y", t2c=COLORS)
    self.play(Write(steps[0]), run_time=vo.until("loss"))
    self.play(Write(steps[1]), run_time=vo.until("derivative"))
    self.play(ShowCreation(boxed(steps[1])), run_time=1)

    axes, graph, labels = plot(lambda x: x ** 2, x_range=(-2, 2, 1), y_range=(0, 4, 1))

Each helper returns ordinary ManimGL objects, to animate as any other. Scenes run with this
folder on their import path, and check.py allows `kit` as it allows `voiceover`.
"""
from manimlib import (
    DL, DOWN, GREY_A, RED, RIGHT, UR, YELLOW,
    Axes, Line, SurroundingRectangle, Tex, Text, VGroup,
)

__all__ = ["derivation", "boxed", "cancel", "plot", "note"]


def derivation(*lines, font_size=40, t2c=None, buff=0.35, align="="):
    """Equations one under another, lined up on their equals signs.

    A line without the `align` symbol is centred under the others. Returns a VGroup of Tex,
    one per line, so each can be written on its own word."""
    rows = VGroup(*[
        Tex(line, font_size=font_size, t2c=t2c or {}, isolate=[align] if align and align in line else [])
        for line in lines
    ])
    rows.arrange(DOWN, buff=buff)
    if not align:
        return rows
    anchors = []
    for line, row in zip(lines, rows):
        part = None
        if align in line:
            try:
                part = row.select_part(align)
            except Exception:  # an unusual line: leave it centred
                part = None
        anchors.append(part if part is not None and len(part.get_points()) else None)
    ref = next((a for a in anchors if a is not None), None)
    if ref is not None:
        x = ref.get_center()[0]
        for row, part in zip(rows, anchors):
            if part is not None:
                row.shift((x - part.get_center()[0]) * RIGHT)
    return rows


def boxed(mobject, color=YELLOW, buff=0.15):
    """A rectangle around a result, to draw with ShowCreation."""
    return SurroundingRectangle(mobject, buff=buff, color=color)


def cancel(mobject, color=RED, width=4):
    """A slash across a term that cancels, from its lower left to its upper right corner."""
    return Line(mobject.get_corner(DL), mobject.get_corner(UR)).set_stroke(color, width)


def plot(function, x_range=(-3, 3, 1), y_range=(-2, 2, 1), width=6, height=4, color=YELLOW, x_label="x", y_label="y"):
    """Axes, the graph of `function` on them, and their labels: (axes, graph, labels)."""
    axes = Axes(x_range=x_range, y_range=y_range, width=width, height=height)
    graph = axes.get_graph(function, color=color)
    labels = axes.get_axis_labels(x_label, y_label)
    return axes, graph, labels


def note(text, font_size=28, color=GREY_A):
    """A short line of plain text, for a word of explanation beside the mathematics."""
    return Text(text, font_size=font_size, color=color)

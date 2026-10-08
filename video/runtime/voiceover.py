"""Sync manim animations to narration spoken by narrate.py.

    from manimlib import *
    from voiceover import VoiceoverScene

    class Intro(VoiceoverScene, Scene):
        def construct(self):
            with self.voiceover("intro") as vo:
                self.play(Write(title), run_time=vo.until("slope"))
                self.play(ShowCreation(line), run_time=vo.remaining())

Entering a block adds its WAV at the current scene time. vo.until(mark) and
vo.remaining() return how long to run so the animation ends on that word, or on
the end of the block. Each is worked out from the absolute target time and the
scene's clock right now, so the whole-frame rounding in play() and wait() never
piles up. Leaving the block waits for its audio to finish.

When $VOICEOVER_REPORT names a file (check.py sets it), the scene also writes
down what went wrong while it ran: animations that ran past a mark or past the
end of a block, and text that left the frame or landed on other text. Each
problem names its block. With $VOICEOVER_SNAPSHOTS set too, it keeps a picture
of the screen at every mark and at the end of every block: the storyboard.

This module runs inside manimgl but never imports manimlib or numpy, so its
arithmetic can be tested with a fake scene.
"""
import json
import logging
import os
from pathlib import Path

log = logging.getLogger("manimgl")

TEXT_TYPES = {"StringMobject", "DecimalNumber"}  # Text, Tex, TexText, Integer... by base class name
OVERLAP = 0.25  # two texts collide when they share this much of the smaller one's box
LATE = 0.3  # seconds an animation may run past its word before the report mentions it
EDGE = 0.05  # how far past the frame edge still counts as on screen, in manim units


class VoiceoverError(Exception):
    pass


class Voiceover:
    """One narration block in progress. Times are in seconds."""

    def __init__(self, scene, block_id, block, wav):
        self.scene = scene
        self.id = block_id
        self.duration = block["duration"]
        self.marks = block.get("marks", {})
        self.has_word_timing = bool(block.get("words"))
        self.wav = wav
        self.start = None

    @property
    def end(self):
        return self.start + self.duration

    def time_of(self, mark):
        """Absolute scene time at which `mark` is spoken."""
        if mark not in self.marks:
            if not self.has_word_timing:
                raise VoiceoverError(
                    f'Block "{self.id}" has no word timing (only English voices have it), '
                    f'so mark "{mark}" cannot be used. Sync to the block with vo.remaining().'
                )
            known = ", ".join(sorted(self.marks)) or "none"
            raise VoiceoverError(f'Block "{self.id}" has no mark "{mark}". Its marks: {known}.')
        return self.start + self.marks[mark]

    def until(self, mark):
        """Seconds from now until `mark` is spoken."""
        return self.scene._voiceover_time_to(self.time_of(mark), f'mark "{mark}" in "{self.id}"')

    def remaining(self):
        """Seconds from now until the block's audio ends."""
        return self.scene._voiceover_time_to(self.end, f'the end of "{self.id}"')

    def __enter__(self):
        self.scene._voiceover_begin(self)
        return self

    def __exit__(self, exc_type, exc, tb):
        self.scene._voiceover_end(self, failed=exc_type is not None)
        return False


class VoiceoverScene:
    """Mixin for a manimgl Scene: put it first, as in class Intro(VoiceoverScene, Scene).

    The manifest comes from $VOICEOVER_MANIFEST (build.py sets it), else from the
    class attribute `voiceover_manifest`.
    """

    voiceover_manifest = None

    def play(self, *args, **kwargs):
        result = super().play(*args, **kwargs)
        self._voiceover_after_step("play")
        return result

    def wait(self, *args, **kwargs):
        result = super().wait(*args, **kwargs)
        self._voiceover_after_step("wait")
        return result

    def voiceover(self, block_id):
        """Context manager that plays narration block `block_id` while its body runs."""
        manifest, base = self._voiceover_manifest()
        if block_id not in manifest["blocks"]:
            known = ", ".join(manifest.get("order") or sorted(manifest["blocks"]))
            raise VoiceoverError(f'No narration block "{block_id}" in {base / "manifest.json"}. Blocks: {known}.')
        block = manifest["blocks"][block_id]
        wav = base / block["wav"]
        if not wav.is_file():
            raise VoiceoverError(f"Narration audio {wav} is missing. Run the narrate pass (build.py does it).")
        return Voiceover(self, block_id, block, wav)

    # ---------- internals ----------

    def _voiceover_manifest(self):
        cached = getattr(self, "_vo_manifest", None)
        if cached:
            return cached
        path = os.environ.get("VOICEOVER_MANIFEST") or self.voiceover_manifest
        if not path:
            raise VoiceoverError(
                "No narration manifest. Render through build.py, or set VOICEOVER_MANIFEST "
                "or the scene's voiceover_manifest attribute to <project>/build/manifest.json."
            )
        path = Path(path)
        if not path.is_file():
            raise VoiceoverError(f"Narration manifest {path} not found. Run the narrate pass first (build.py does it).")
        self._vo_manifest = (json.loads(path.read_text(encoding="utf-8")), path.parent)
        return self._vo_manifest

    def _voiceover_frame(self):
        return 1 / self.camera.fps

    def _voiceover_time_to(self, target, what):
        """target - now, kept to at least one frame so play() always gets a real run_time."""
        frame = self._voiceover_frame()
        left = target - self.time
        if left < frame:
            if left < -frame:
                log.warning(f"Voiceover: animations are {-left:.2f}s past {what}; running one frame instead")
                if -left > LATE:
                    active = getattr(self, "_vo_active", None)
                    self._voiceover_issue("timing", f"the animations before it ran {-left:.2f}s past {what}", block=active and active.id)
            return frame
        return left

    def _voiceover_begin(self, vo):
        if getattr(self, "_vo_active", None):
            raise VoiceoverError(f'Voiceover "{vo.id}" started inside "{self._vo_active.id}". Blocks cannot overlap.')
        checking = bool(os.environ.get("VOICEOVER_REPORT"))  # check.py skips on purpose
        if self.skip_animations and not checking and not getattr(self, "_vo_warned_skip", False):
            self._vo_warned_skip = True
            log.warning("Voiceover: animations are being skipped (-n or -s), so manim adds no audio for them. Render in full to hear narration.")
        vo.start = self.time
        self.add_sound(str(vo.wav))
        self._vo_active = vo
        self._vo_timeline = getattr(self, "_vo_timeline", [])
        self._vo_timeline.append({"id": vo.id, "start": round(vo.start, 6), "duration": vo.duration})
        self._voiceover_write_timeline()

    def _voiceover_end(self, vo, failed=False):
        if failed:
            self._vo_active = None
            return
        left = vo.end - self.time
        if left > 1e-9:
            self.wait(left)  # rounds up to whole frames, so the clock lands on or just past the end
        elif left <= -self._voiceover_frame():  # less than a frame over is only rounding
            log.warning(f'Voiceover: animations in "{vo.id}" ran {-left:.2f}s past the end of its narration')
            if -left > LATE:
                self._voiceover_issue("timing", f'the animations in block "{vo.id}" ran {-left:.2f}s past the end of its narration', block=vo.id)
        self._voiceover_take_pending()  # a reveal that never came: the screen as the block ends
        self._vo_active = None
        self._voiceover_inspect(f'at the end of block "{vo.id}"', vo.id, block=vo.id)

    def _voiceover_write_timeline(self):
        """Tell build.py when each block started, for the captions."""
        path = os.environ.get("VOICEOVER_TIMELINE")
        if not path or self.skip_animations:
            return
        data = {"scene": type(self).__name__, "fps": self.camera.fps, "blocks": self._vo_timeline}
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(json.dumps(data, indent=1), encoding="utf-8")

    # ---------- checking (only when $VOICEOVER_REPORT is set) ----------

    def tear_down(self):
        self._voiceover_inspect("in the last frame", "end")
        parent = getattr(super(), "tear_down", None)
        if parent:
            parent()

    def _voiceover_after_step(self, step):
        """After a play or wait, take the storyboard's still for any mark the clock has reached.

        Animations are skipped while checking, so the screen after a play is the screen once it
        has finished. A play that ran up to a mark is pictured as it ends. A wait that ran up to
        a mark is the other pattern (wait for the word, then reveal), so its still is taken after
        the next play, once the reveal is on screen.
        """
        if not os.environ.get("VOICEOVER_SNAPSHOTS"):
            return
        if step == "play":
            self._voiceover_take_pending()
        vo = getattr(self, "_vo_active", None)
        if vo is None:
            return
        done = self.__dict__.setdefault("_vo_marks_done", set())
        reached = [m for m, at in sorted(vo.marks.items(), key=lambda kv: kv[1]) if (vo.id, m) not in done and vo.start + at <= self.time + 1e-6]
        for mark in reached:
            done.add((vo.id, mark))
            if step == "play":
                self._voiceover_still(vo, mark)
            else:
                self.__dict__.setdefault("_vo_pending", []).append((vo, mark))

    def _voiceover_take_pending(self):
        for vo, mark in self.__dict__.pop("_vo_pending", []):
            self._voiceover_still(vo, mark)

    def _voiceover_still(self, vo, mark):
        name = f"{type(self).__name__}-{vo.id}--{mark}"
        if self._voiceover_snapshot(name):
            self.__dict__.setdefault("_vo_stills", []).append(
                {"block": vo.id, "mark": mark, "file": f"{name}.png", "at": round(vo.marks[mark], 3)})
        self._voiceover_write_report()

    def _voiceover_snapshot(self, name):
        """Save the screen as <name>.png in $VOICEOVER_SNAPSHOTS. True when it was saved."""
        shots = os.environ.get("VOICEOVER_SNAPSHOTS")
        if not shots:
            return False
        try:  # a picture must never be what breaks a check
            Path(shots).mkdir(parents=True, exist_ok=True)
            self.update_frame(dt=0, force_draw=True)
            self.get_image().save(str(Path(shots) / f"{name}.png"))
            return True
        except Exception as e:
            log.warning(f"Voiceover: could not save a picture of the frame ({name}): {e}")
            return False

    def _voiceover_issue(self, kind, message, key=None, block=None):
        """Note a problem once. `key` names it, for one that would otherwise repeat at every check."""
        seen = self.__dict__.setdefault("_vo_issue_keys", set())
        if (key or message) not in seen:
            seen.add(key or message)
            self.__dict__.setdefault("_vo_issues", []).append({"kind": kind, "message": message, "block": block, "scene": type(self).__name__})
        self._voiceover_write_report()

    def _voiceover_write_report(self):
        path = os.environ.get("VOICEOVER_REPORT")
        if not path:
            return
        data = {
            "scene": type(self).__name__,
            "time": round(self.time, 3),
            "blocks": getattr(self, "_vo_timeline", []),
            "issues": getattr(self, "_vo_issues", []),
            "stills": getattr(self, "_vo_stills", []),
        }
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(json.dumps(data, indent=1), encoding="utf-8")

    def _voiceover_inspect(self, where, name, block=None):
        """Note layout problems on screen right now, and keep a picture of the frame."""
        if not os.environ.get("VOICEOVER_REPORT"):
            return
        try:  # a check must never be what breaks a render
            for problem in self._voiceover_layout_issues():
                self._voiceover_issue("layout", f"{problem} {where}", key=problem, block=block)
        except Exception as e:
            log.warning(f"Voiceover: could not inspect the frame {where}: {e}")
        file = f"{type(self).__name__}-{name}.png"
        if self._voiceover_snapshot(file[:-4]):
            vo_end = next((b for b in reversed(getattr(self, "_vo_timeline", [])) if b["id"] == block), None)
            self.__dict__.setdefault("_vo_stills", []).append(
                {"block": block, "mark": None, "file": file, "at": round(vo_end["duration"], 3) if vo_end else None})
        self._voiceover_write_report()

    def _voiceover_texts(self):
        """[(label, x0, y0, x1, y1)] for every visible piece of text in the scene."""
        seen, out = set(), []
        for top in self.mobjects:
            for mob in top.get_family():
                if id(mob) in seen or not TEXT_TYPES & {c.__name__ for c in type(mob).__mro__}:
                    continue
                seen.update(id(m) for m in mob.get_family())  # a number's digits are texts too
                parts = mob.family_members_with_points()
                if not parts or mob.is_fixed_in_frame():
                    continue
                if not any(p.get_fill_opacity() > 0.05 or p.get_stroke_opacity() > 0.05 for p in parts):
                    continue
                low, _, high = mob.get_bounding_box()
                raw = getattr(mob, "text", None) or getattr(mob, "string", None)
                if raw is None:
                    raw = mob.get_value() if hasattr(mob, "get_value") else type(mob).__name__
                label = " ".join(str(raw).split())
                out.append((label if len(label) <= 40 else label[:37] + "...", low[0], low[1], high[0], high[1]))
        return out

    def _voiceover_layout_issues(self):
        frame = self.frame
        if any(abs(a) > 1e-3 for a in frame.get_euler_angles()):
            return []  # a tilted camera: flat boxes say nothing about what is on screen
        cx, cy = frame.get_center()[:2]
        half_w, half_h = frame.get_width() / 2, frame.get_height() / 2
        texts, out = self._voiceover_texts(), []
        for label, x0, y0, x1, y1 in texts:
            past = {
                "left": (cx - half_w) - x0, "right": x1 - (cx + half_w),
                "bottom": (cy - half_h) - y0, "top": y1 - (cy + half_h),
            }
            side, amount = max(past.items(), key=lambda kv: kv[1])
            if amount > EDGE:
                out.append(f'text "{label}" runs {amount:.1f} units past the {side} edge of the frame')
        for i, (a, ax0, ay0, ax1, ay1) in enumerate(texts):
            for b, bx0, by0, bx1, by1 in texts[i + 1:]:
                w = min(ax1, bx1) - max(ax0, bx0)
                h = min(ay1, by1) - max(ay0, by0)
                smaller = min((ax1 - ax0) * (ay1 - ay0), (bx1 - bx0) * (by1 - by0))
                if w > 0 and h > 0 and smaller > 0 and w * h / smaller > OVERLAP:
                    out.append(f'text "{a}" and text "{b}" overlap')
        return out

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

This module runs inside manimgl but never imports manimlib or numpy, so its
arithmetic can be tested with a fake scene.
"""
import json
import logging
import os
from pathlib import Path

log = logging.getLogger("manimgl")


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
            return frame
        return left

    def _voiceover_begin(self, vo):
        if getattr(self, "_vo_active", None):
            raise VoiceoverError(f'Voiceover "{vo.id}" started inside "{self._vo_active.id}". Blocks cannot overlap.')
        if self.skip_animations and not getattr(self, "_vo_warned_skip", False):
            self._vo_warned_skip = True
            log.warning("Voiceover: animations are being skipped (-n or -s), so manim adds no audio for them. Render in full to hear narration.")
        vo.start = self.time
        self.add_sound(str(vo.wav))
        self._vo_active = vo
        self._vo_timeline = getattr(self, "_vo_timeline", [])
        self._vo_timeline.append({"id": vo.id, "start": round(vo.start, 6), "duration": vo.duration})
        self._voiceover_write_timeline()

    def _voiceover_end(self, vo, failed=False):
        self._vo_active = None
        if failed:
            return
        left = vo.end - self.time
        if left > 1e-9:
            self.wait(left)  # rounds up to whole frames, so the clock lands on or just past the end
        elif left <= -self._voiceover_frame():  # less than a frame over is only rounding
            log.warning(f'Voiceover: animations in "{vo.id}" ran {-left:.2f}s past the end of its narration')

    def _voiceover_write_timeline(self):
        """Tell build.py when each block started, for the captions."""
        path = os.environ.get("VOICEOVER_TIMELINE")
        if not path or self.skip_animations:
            return
        data = {"scene": type(self).__name__, "fps": self.camera.fps, "blocks": self._vo_timeline}
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(json.dumps(data, indent=1), encoding="utf-8")

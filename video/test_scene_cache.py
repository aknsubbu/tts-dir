"""The scene cache in build.py and the scenes.py reading it depends on. Nothing is rendered."""
import ast
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import build
import project_ast

SCENES = '''from manimlib import *
from voiceover import VoiceoverScene

COLORS = {"w": BLUE}


def helper():
    return Dot()


class Intro(VoiceoverScene, Scene):
    def construct(self):
        with self.voiceover("intro") as vo:
            self.play(Write(Text("Intro")), run_time=vo.remaining())


# The middle scene, with a decorator to keep with it.
@staticmethod
def _unused():
    pass


class Middle(VoiceoverScene, Scene):
    def construct(self):
        with self.voiceover("middle") as vo:
            self.wait(vo.until("here"))
        with self.voiceover("again") as vo:
            self.wait(vo.remaining())


class Base(VoiceoverScene, Scene):
    def setup(self):
        pass


class Child(Base):
    def construct(self):
        pass


class Last(Base, VoiceoverScene):
    def construct(self):
        with self.voiceover("outro") as vo:
            self.wait(vo.remaining())
'''

MANIFEST = {
    "order": ["intro", "middle", "again", "outro"],
    "blocks": {
        "intro": {"wav": "audio/intro-aaa.wav", "duration": 2.0, "marks": {}, "text": "Intro.", "words": []},
        "middle": {"wav": "audio/middle-bbb.wav", "duration": 3.0, "marks": {"here": 1.2}, "text": "Middle here.", "words": []},
        "again": {"wav": "audio/again-ccc.wav", "duration": 1.0, "marks": {}, "text": "Again.", "words": []},
        "outro": {"wav": "audio/outro-ddd.wav", "duration": 1.5, "marks": {}, "text": "Bye.", "words": []},
    },
}


class ProjectAstTest(unittest.TestCase):
    def setUp(self):
        self.tree = ast.parse(SCENES)

    def test_finds_scene_classes_and_the_blocks_each_plays(self):
        classes = project_ast.scene_classes(self.tree)
        self.assertEqual(list(classes), ["Intro", "Middle", "Base", "Last"])  # Child's bases name only Base
        self.assertEqual(project_ast.blocks_played(classes["Middle"]), ["middle", "again"])

    def test_a_class_span_takes_the_comment_lines_above_it(self):
        lines = SCENES.splitlines()
        middle = project_ast.scene_classes(self.tree)["Middle"]
        first, last = project_ast.class_span(middle, lines)
        self.assertEqual(lines[first - 1], "class Middle(VoiceoverScene, Scene):")
        intro = project_ast.scene_classes(self.tree)["Intro"]
        self.assertEqual(lines[project_ast.class_span(intro, lines)[1] - 1].strip(), "self.play(Write(Text(\"Intro\")), run_time=vo.remaining())")

    def fingerprint(self, source, name):
        return project_ast.scene_fingerprint(source, ast.parse(source), name)

    def test_a_scene_fingerprint_follows_its_own_class_and_the_shared_code_only(self):
        before = {n: self.fingerprint(SCENES, n) for n in ("Intro", "Middle", "Last")}
        edited = SCENES.replace('Write(Text("Intro"))', 'FadeIn(Text("Intro"))')
        self.assertNotEqual(self.fingerprint(edited, "Intro"), before["Intro"])
        self.assertEqual(self.fingerprint(edited, "Middle"), before["Middle"])
        shared = SCENES.replace('{"w": BLUE}', '{"w": RED}')
        self.assertTrue(all(self.fingerprint(shared, n) != before[n] for n in before))

    def test_a_scene_fingerprint_follows_the_scene_it_inherits_from(self):
        before = self.fingerprint(SCENES, "Last")
        edited = SCENES.replace("    def setup(self):\n        pass", "    def setup(self):\n        self.add(Dot())")
        self.assertNotEqual(self.fingerprint(edited, "Last"), before)
        self.assertEqual(self.fingerprint(edited, "Intro"), self.fingerprint(SCENES, "Intro"))


class SceneCacheTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "lesson"
        (self.root / "build").mkdir(parents=True)
        (self.root / "scenes.py").write_text(SCENES, encoding="utf-8")
        self.config = {"scenes_file": "scenes.py", "scenes": ["Intro", "Middle", "Last"]}
        (self.root / "project.json").write_text(json.dumps(self.config), encoding="utf-8")
        (self.root / "build" / "manifest.json").write_text(json.dumps(MANIFEST), encoding="utf-8")
        self.rendered = []

    def fake_render(self, root, config, scene, quality):
        self.rendered.append(scene)
        out = root / "build" / "scenes" / f"{scene}.mp4"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(f"{scene} {quality} {len(self.rendered)}")
        timeline = root / "build" / "timeline" / f"{scene}.json"
        timeline.parent.mkdir(parents=True, exist_ok=True)
        timeline.write_text(json.dumps({"scene": scene, "blocks": [{"id": {"Last": "outro"}.get(scene, scene.lower()), "start": 0.5}]}))
        return out, timeline

    def keys(self, manifest=MANIFEST, quality="low"):
        return build.scene_keys(self.root, self.config, manifest, quality)

    def test_keys_change_only_for_scenes_whose_narration_changed(self):
        before = self.keys()
        manifest = json.loads(json.dumps(MANIFEST))
        manifest["blocks"]["again"]["duration"] = 1.4
        after = self.keys(manifest)
        self.assertEqual(after["Intro"], before["Intro"])
        self.assertNotEqual(after["Middle"], before["Middle"])
        self.assertEqual(after["Last"], before["Last"])
        self.assertTrue(all(self.keys(quality="hd")[s] != before[s] for s in before))

    def test_an_unchanged_scene_is_reused_and_a_changed_one_rendered_again(self):
        with mock.patch.object(build, "render", self.fake_render):
            keys = self.keys()
            for scene in self.config["scenes"]:
                build.cached_render(self.root, self.config, scene, "low", keys[scene])
            self.assertEqual(self.rendered, ["Intro", "Middle", "Last"])

            (self.root / "scenes.py").write_text(SCENES.replace('Text("Intro")', 'Text("Hello")'), encoding="utf-8")
            keys = self.keys()
            results = {s: build.cached_render(self.root, self.config, s, "low", keys[s]) for s in self.config["scenes"]}
            self.assertEqual(self.rendered[3:], ["Intro"])
            mp4, timeline = results["Middle"]
            self.assertEqual(mp4.read_text(), "Middle low 2")
            self.assertEqual(json.loads(timeline.read_text())["scene"], "Middle")  # restored for the captions

            build.cached_render(self.root, self.config, "Last", "low", keys["Last"], use_cache=False)
            self.assertEqual(self.rendered[-1], "Last")

    def test_the_cache_keeps_what_the_last_builds_used(self):
        cache = self.root / "build" / "cache"
        cache.mkdir()
        for used in (["Intro-1", "Middle-1"], ["Intro-2"], ["Intro-3"], ["Intro-4"]):
            for name in used:  # each build writes what it rendered, then prunes
                (cache / f"{name}.mp4").write_text("x")
                (cache / f"{name}.timeline.json").write_text("null")
            build.prune_cache(self.root, used)
        left = sorted(p.name for p in cache.glob("*.mp4"))
        self.assertEqual(left, ["Intro-2.mp4", "Intro-3.mp4", "Intro-4.mp4"])
        self.assertFalse((cache / "Middle-1.timeline.json").exists())

    def test_a_second_build_renders_nothing_and_records_the_keys(self):
        probe = lambda path: {"duration": 2.0, "audio": True}  # noqa: E731
        with mock.patch.object(build, "render", self.fake_render), mock.patch.object(build, "probe", probe), \
                mock.patch.object(build, "run", lambda cmd, **kw: Path(cmd[-1]).write_text("joined")), \
                mock.patch.object(build, "poster", lambda *a: None), mock.patch.object(build.shutil, "which", lambda t: t):
            build.build(self.root, "low", narrate_first=False)
            result = build.build(self.root, "low", narrate_first=False)
        self.assertEqual(self.rendered, ["Intro", "Middle", "Last"])
        self.assertTrue(all(s["key"] for s in result["scenes"]))
        self.assertEqual([s["offset"] for s in result["scenes"]], [0.0, 2.0, 4.0])


if __name__ == "__main__":
    unittest.main()

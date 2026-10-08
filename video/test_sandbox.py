import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import sandbox

PROBE = """
import os, pathlib, sys, urllib.request
kind, target = sys.argv[1], sys.argv[2]
try:
    if kind == "write":
        pathlib.Path(target).write_text("x")
    elif kind == "read":
        list(pathlib.Path(target).iterdir())
    elif kind == "env":
        print("allowed" if target in os.environ else "denied")
        sys.exit(0)
    else:
        urllib.request.urlopen(target, timeout=5)
    print("allowed")
except Exception as e:
    print("denied", type(e).__name__)
"""


@unittest.skipUnless(sandbox.available(), "needs sandbox-exec (macOS)")
class SandboxTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path.home())  # outside every folder the sandbox may write
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "projects" / "mine"
        self.other = Path(self.tmp.name) / "projects" / "theirs"
        (self.root / "build").mkdir(parents=True)
        self.other.mkdir()
        cache = mock.patch.dict(os.environ, {"VIDEO_SCENE_CACHE": str(Path(self.tmp.name) / "scene-cache")})
        cache.start()
        self.addCleanup(cache.stop)

    def probe(self, kind, target):
        env, _, limits = sandbox.prepare(self.root)
        done = subprocess.run(
            sandbox.wrap([sys.executable, "-c", PROBE, kind, str(target)], self.root),
            capture_output=True, text=True, env=env, preexec_fn=limits,
        )
        return done.stdout.split()[0] if done.stdout else done.stderr

    def test_a_scene_writes_in_its_build_folder_and_nowhere_else(self):
        self.assertEqual(self.probe("write", self.root / "build" / "out.txt"), "allowed")
        self.assertEqual(self.probe("write", sandbox.cache_root() / "probe.txt"), "allowed")
        self.assertEqual(self.probe("write", Path(tempfile.gettempdir()) / "sandbox-probe.txt"), "allowed")
        self.assertEqual(self.probe("write", self.root / "scenes.py"), "denied")  # not even its own sources
        self.assertEqual(self.probe("write", self.other / "scenes.py"), "denied")
        self.assertEqual(self.probe("write", Path(self.tmp.name) / "above.txt"), "denied")
        self.assertFalse((self.root / "scenes.py").exists())
        self.assertFalse((self.other / "scenes.py").exists())

    def test_caches_other_programs_trust_cannot_be_written(self):
        target = Path.home() / "Library" / "Caches" / "narrated-proofs-sandbox-probe.txt"
        self.addCleanup(lambda: target.unlink(missing_ok=True))
        self.assertEqual(self.probe("write", target), "denied")
        self.assertFalse(target.exists())

    def test_no_network(self):
        self.assertEqual(self.probe("fetch", "http://127.0.0.1:9/"), "denied")
        self.assertEqual(self.probe("fetch", "http://example.com/"), "denied")

    def test_where_keys_are_kept_cannot_be_read(self):
        ssh = Path.home() / ".ssh"
        if not ssh.is_dir():
            self.skipTest("no ~/.ssh here")
        self.assertEqual(self.probe("read", ssh), "denied")
        self.assertEqual(self.probe("read", self.root), "allowed")


class PrepareTest(unittest.TestCase):
    """What every scene run gets, sandbox or not."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "lesson"
        self.root.mkdir()
        env = mock.patch.dict(os.environ, {"VIDEO_SCENE_CACHE": str(Path(self.tmp.name) / "cache"), "FAKE_API_KEY": "sk-secret"})
        env.start()
        self.addCleanup(env.stop)

    def test_a_scene_gets_a_short_environment_and_its_own_folders(self):
        env, args, _ = sandbox.prepare(self.root, {"VOICEOVER_REPORT": "r.json"})
        self.assertNotIn("FAKE_API_KEY", env)
        self.assertEqual(env["VOICEOVER_REPORT"], "r.json")
        self.assertEqual(env["TMPDIR"], str((self.root / "build" / "tmp").resolve()))
        cache = Path(self.tmp.name).resolve() / "cache"
        self.assertEqual(env["XDG_CACHE_HOME"], str(cache))
        self.assertTrue(env["MPLCONFIGDIR"].startswith(str(cache)))
        self.assertTrue((self.root / "build" / "tmp").is_dir())
        self.assertEqual(args[0], "--config_file")
        config = json.loads(Path(args[1]).read_text())
        self.assertEqual(config["directories"]["subdirs"]["latex_cache"], str((self.root / "build" / "latex_cache").resolve()))
        self.assertEqual(config["directories"]["cache"], str(cache / "manim"))

    def test_the_environment_seen_inside_has_no_secrets(self):
        env, _, limits = sandbox.prepare(self.root)
        done = subprocess.run([sys.executable, "-c", PROBE, "env", "FAKE_API_KEY"], capture_output=True, text=True, env=env, preexec_fn=limits)
        self.assertEqual(done.stdout.strip(), "denied")

    @unittest.skipUnless(hasattr(os, "fork"), "POSIX only")
    def test_limits_reach_the_child(self):
        code = "import resource; print(resource.getrlimit(resource.RLIMIT_CPU)[0], resource.getrlimit(resource.RLIMIT_FSIZE)[0])"
        done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, preexec_fn=sandbox.limits)
        cpu, size = (int(v) for v in done.stdout.split())
        self.assertLessEqual(cpu, sandbox.CPU_SECONDS)
        self.assertLessEqual(size, sandbox.MAX_FILE_BYTES)


class WrapTest(unittest.TestCase):
    def test_turned_off_or_missing_leaves_the_command_alone(self):
        with mock.patch.dict(os.environ, {"VIDEO_SANDBOX": "0"}):
            self.assertEqual(sandbox.wrap(["manimgl", "scenes.py"], "/tmp/x"), ["manimgl", "scenes.py"])
        with mock.patch.object(sandbox, "SANDBOX_EXEC", "/nowhere/sandbox-exec"):
            self.assertEqual(sandbox.wrap(["manimgl"], "/tmp/x"), ["manimgl"])

    def test_the_profile_gets_the_build_folder_not_the_project(self):
        with mock.patch.object(sandbox, "available", lambda: True):
            args = sandbox.wrap(["manimgl"], "/tmp/x")
        self.assertIn(f"BUILD={Path('/tmp/x/build').resolve()}", args)
        self.assertNotIn("PROJECT", " ".join(args[:-2]))
        self.assertEqual(args[-1], "manimgl")


if __name__ == "__main__":
    unittest.main()

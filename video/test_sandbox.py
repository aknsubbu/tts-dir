import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import sandbox

PROBE = """
import pathlib, sys, urllib.request
kind, target = sys.argv[1], sys.argv[2]
try:
    if kind == "write":
        pathlib.Path(target).write_text("x")
    elif kind == "read":
        list(pathlib.Path(target).iterdir())
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
        self.root.mkdir(parents=True)
        self.other.mkdir()

    def probe(self, kind, target):
        done = subprocess.run(sandbox.wrap([sys.executable, "-c", PROBE, kind, str(target)], self.root), capture_output=True, text=True)
        return done.stdout.split()[0] if done.stdout else done.stderr

    def test_a_scene_writes_in_its_own_project_and_nowhere_else(self):
        self.assertEqual(self.probe("write", self.root / "build.txt"), "allowed")
        self.assertEqual(self.probe("write", Path(tempfile.gettempdir()) / "sandbox-probe.txt"), "allowed")
        self.assertEqual(self.probe("write", self.other / "scenes.py"), "denied")
        self.assertEqual(self.probe("write", Path(self.tmp.name) / "above.txt"), "denied")
        self.assertFalse((self.other / "scenes.py").exists())

    def test_no_network(self):
        self.assertEqual(self.probe("fetch", "http://127.0.0.1:9/"), "denied")
        self.assertEqual(self.probe("fetch", "http://example.com/"), "denied")

    def test_where_keys_are_kept_cannot_be_read(self):
        ssh = Path.home() / ".ssh"
        if not ssh.is_dir():
            self.skipTest("no ~/.ssh here")
        self.assertEqual(self.probe("read", ssh), "denied")
        self.assertEqual(self.probe("read", self.root), "allowed")


class WrapTest(unittest.TestCase):
    def test_turned_off_or_missing_leaves_the_command_alone(self):
        with mock.patch.dict(os.environ, {"VIDEO_SANDBOX": "0"}):
            self.assertEqual(sandbox.wrap(["manimgl", "scenes.py"], "/tmp/x"), ["manimgl", "scenes.py"])
        with mock.patch.object(sandbox, "SANDBOX_EXEC", "/nowhere/sandbox-exec"):
            self.assertEqual(sandbox.wrap(["manimgl"], "/tmp/x"), ["manimgl"])


if __name__ == "__main__":
    unittest.main()

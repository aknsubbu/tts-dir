import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import sandbox

PROBE = """
import os, pathlib, subprocess, sys, urllib.request
kind, target = sys.argv[1], sys.argv[2]
try:
    if kind == "write":
        pathlib.Path(target).write_text("x")
    elif kind == "read":
        p = pathlib.Path(target)
        list(p.iterdir()) if p.is_dir() else p.read_bytes()
    elif kind == "start":
        subprocess.run([target], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
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
        self.tmp = tempfile.TemporaryDirectory(dir=Path.home())  # outside every folder the sandbox may read or write
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "projects" / "mine"
        self.other = Path(self.tmp.name) / "projects" / "theirs"
        (self.root / "build").mkdir(parents=True)
        self.other.mkdir()
        (self.root / "scenes.py").write_text("# mine\n")
        (self.other / "scenes.py").write_text("# theirs\n")
        (Path(self.tmp.name) / "private.txt").write_text("in the home folder\n")
        env = mock.patch.dict(os.environ, {"VIDEO_SCENE_CACHE": str(Path(self.tmp.name) / "scene-cache")})
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("VIDEO_SANDBOX", None)

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
        self.assertEqual((self.root / "scenes.py").read_text(), "# mine\n")
        self.assertEqual((self.other / "scenes.py").read_text(), "# theirs\n")

    def test_caches_other_programs_trust_cannot_be_written(self):
        for folder in (Path.home() / "Library" / "Caches", Path.home() / ".cache"):
            folder.mkdir(exist_ok=True)
            target = folder / "narrated-proofs-sandbox-probe.txt"
            self.addCleanup(lambda t=target: t.unlink(missing_ok=True))
            self.assertEqual(self.probe("write", target), "denied")
            self.assertFalse(target.exists())

    def test_no_network(self):
        self.assertEqual(self.probe("fetch", "http://127.0.0.1:9/"), "denied")
        self.assertEqual(self.probe("fetch", "http://example.com/"), "denied")

    def test_it_reads_its_own_project_and_nothing_else_of_yours(self):
        self.assertEqual(self.probe("read", self.root / "scenes.py"), "allowed")
        self.assertEqual(self.probe("read", self.root), "allowed")
        self.assertEqual(self.probe("read", sandbox.RUNTIME / "voiceover.py"), "allowed")
        self.assertEqual(self.probe("read", self.other / "scenes.py"), "denied")
        self.assertEqual(self.probe("read", self.other), "denied")
        self.assertEqual(self.probe("read", Path(self.tmp.name) / "private.txt"), "denied")
        self.assertEqual(self.probe("read", Path.home()), "denied")
        self.assertEqual(self.probe("read", sandbox.HERE / "build.py"), "denied")  # the toolchain is not the runtime

    def test_where_keys_are_kept_cannot_be_read(self):
        ssh = Path.home() / ".ssh"
        if not ssh.is_dir():
            self.skipTest("no ~/.ssh here")
        self.assertEqual(self.probe("read", ssh), "denied")

    def test_it_starts_no_other_program(self):
        self.assertEqual(self.probe("start", "/usr/bin/open"), "denied")
        self.assertEqual(self.probe("start", "/usr/bin/osascript"), "denied")
        self.assertEqual(self.probe("start", "/bin/sh"), "denied")
        self.assertEqual(self.probe("start", sys.executable), "allowed")  # the Python that runs it

    def test_report_mode_allows_and_logs_reads_and_starts_but_not_writes(self):
        with mock.patch.dict(os.environ, {"VIDEO_SANDBOX": "report"}):
            self.assertEqual(self.probe("read", self.other / "scenes.py"), "allowed")
            self.assertEqual(self.probe("write", self.other / "scenes.py"), "denied")
            self.assertEqual(self.probe("fetch", "http://127.0.0.1:9/"), "denied")
        self.assertEqual((self.other / "scenes.py").read_text(), "# theirs\n")


@unittest.skipUnless(sandbox.available(), "needs sandbox-exec (macOS)")
class RenderTest(unittest.TestCase):
    """A real render under the strict rules: shapes and Text, through manimgl and ffmpeg."""

    def test_the_smoke_scene_renders_inside_the_sandbox(self):
        import build
        if not Path(build.MANIMGL).exists() or not shutil.which("ffmpeg"):
            self.skipTest("needs video/.venv (manimgl) and ffmpeg")
        tmp = tempfile.TemporaryDirectory(dir=Path.home())
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name) / "smoke"
        (root / "build").mkdir(parents=True)
        shutil.copy(sandbox.HERE / "smoke" / "smoke_scene.py", root / "smoke_scene.py")
        env, args, limits = sandbox.prepare(root, {"PYTHONPATH": str(sandbox.RUNTIME)})
        cmd = [build.MANIMGL, root / "smoke_scene.py", "SmokeText", "-w", *build.QUALITY["low"], "--video_dir", root / "build" / "out", *args]
        done = subprocess.run([str(c) for c in sandbox.wrap(cmd, root)], cwd=root, env=env, preexec_fn=limits,
                              stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=900)
        self.assertEqual(done.returncode, 0, done.stdout[-2000:] + done.stderr[-2000:])
        self.assertTrue(list((root / "build" / "out").rglob("SmokeText.mp4")))


class ProfileTest(unittest.TestCase):
    """The rules themselves, on any platform."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.root = self.base / "projects" / "mine"
        (self.root / "build").mkdir(parents=True)
        self.bin = self.base / "bin"
        self.bin.mkdir()
        env = mock.patch.dict(os.environ, {"VIDEO_SCENE_CACHE": str(self.base / "cache")})
        env.start()
        self.addCleanup(env.stop)

    def tool(self, name, body):
        path = self.bin / name
        path.write_text("#!/bin/sh\n" + body)
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
        return path

    def test_strict_reads_only_what_rendering_needs_and_keeps_private_folders_last(self):
        text = sandbox.profile([sys.executable, "scenes.py"], self.root, how="strict", search="")
        self.assertIn("(deny file-read*)", text)
        self.assertIn("(allow file-read-metadata)", text)
        self.assertIn(f'(subpath "{self.root}")', text)
        self.assertIn(f'(subpath "{sandbox.RUNTIME}")', text)
        self.assertIn(f'(subpath "{Path(os.__file__).resolve().parent}")', text)  # the standard library
        self.assertIn('(literal "/")', text)
        self.assertNotIn('(subpath "/")', text)
        self.assertNotIn(f'(subpath "{Path.home().resolve()}")', text)
        self.assertNotIn(f'(subpath "{sandbox.HERE}")', text)  # the toolchain and every project stay out
        self.assertIn("(deny process-exec*)", text)
        self.assertIn('(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd")', text)
        self.assertIn("(deny network*)", text)
        last = text.strip().splitlines()[-1]
        self.assertTrue(last.startswith("(deny file-read* (subpath") and last.endswith('"))'), last)

    def test_report_mode_reports_instead_of_denying_the_new_rules_only(self):
        text = sandbox.profile([sys.executable], self.root, how="report", search="")
        self.assertIn("(allow file-read* (with report))", text)
        self.assertIn("(allow process-exec* (with report))", text)
        self.assertIn('(allow mach-lookup (with report) (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.pasteboard.1"))', text)
        self.assertNotIn("(deny file-read*)", text)
        self.assertIn("(deny network*)", text)
        self.assertIn("(deny file-write*)", text)
        self.assertIn(f'(deny file-read* (subpath "{Path.home().resolve() / ".ssh"}"))', text)

    def test_tex_and_ffmpeg_are_found_on_the_path(self):
        tree = self.base / "texlive"
        (tree / "2025" / "bin").mkdir(parents=True)
        (tree / "2025" / "texmf-dist").mkdir()
        self.tool("kpsewhich", f'case "$1" in -var-value=SELFAUTOGRANDPARENT) echo "{tree}";; -var-value=TEXMFDIST) echo "{tree}/2025/texmf-dist";; *) echo "~/no-such-texmf";; esac\n')
        self.tool("latex", "exit 0\n")
        self.tool("ffmpeg", "exit 0\n")
        self.tool("osascript", "exit 0\n")
        read, start = sandbox.allowed([sys.executable], self.root, search=str(self.bin))
        self.assertIn(tree, start)
        self.assertIn(self.bin / "latex", start)
        self.assertIn(self.bin / "ffmpeg", start)
        self.assertNotIn(self.bin, start)  # not the folder of links they are in
        self.assertNotIn(self.bin / "osascript", start)
        self.assertIn(tree, read)
        self.assertIn(tree / "2025" / "texmf-dist", read)
        self.assertNotIn(Path("~/no-such-texmf").expanduser(), read)

    def test_homebrew_tex_opens_its_own_folder_not_the_cellar(self):
        tree = self.base / "brew" / "Cellar" / "texlive"
        (tree / "2025" / "bin").mkdir(parents=True)
        self.tool("kpsewhich", f'case "$1" in -var-value=SELFAUTOGRANDPARENT) echo "{tree.parent}";; -var-value=SELFAUTOPARENT) echo "{tree}";; *) echo "";; esac\n')
        _, start = sandbox.allowed([sys.executable], self.root, search=str(self.bin))
        self.assertIn(tree, start)
        self.assertNotIn(tree.parent, start)

    def test_a_python_installed_in_a_shared_folder_opens_only_itself(self):
        with mock.patch.object(sandbox, "_output", lambda cmd, timeout=30: json.dumps(["/usr", "/usr", "/usr/bin/python3", ["/usr/lib/python3.12"]])):
            sandbox.python_paths.cache_clear()
            self.addCleanup(sandbox.python_paths.cache_clear)
            read, start = sandbox.allowed(["/usr/bin/python3"], self.root, search="")
        self.assertIn(Path("/usr/bin/python3"), start)
        for wide in ("/usr", "/usr/bin"):
            self.assertNotIn(Path(wide), start)
            self.assertNotIn(Path(wide), read)
        self.assertIn(Path("/usr/lib/python3.12"), read)

    def test_a_homebrew_program_brings_its_libraries_but_not_its_data(self):
        cellar = self.base / "brew" / "Cellar" / "ffmpeg" / "7.1" / "bin"
        cellar.mkdir(parents=True)
        real = cellar / "ffmpeg"
        real.write_text("#!/bin/sh\nexit 0\n")
        real.chmod(0o755)
        (self.base / "path").mkdir()
        (self.base / "path" / "ffmpeg").symlink_to(real)
        read, start = sandbox.allowed([sys.executable], self.root, search=str(self.base / "path"))
        prefix = self.base / "brew"
        self.assertIn(real, start)
        self.assertIn(prefix / "opt", read)
        self.assertIn(prefix / "lib", read)
        self.assertIn(prefix / "etc" / "fonts", read)
        self.assertNotIn(prefix / "var", read)
        self.assertNotIn(prefix / "etc", read)
        self.assertNotIn(prefix / "opt", start)

    def test_the_interpreter_is_found_from_a_scripts_first_line(self):
        direct = self.tool("manimgl", "")
        direct.write_text(f"#!{sys.executable}\nprint(1)\n")
        self.assertEqual(sandbox.interpreter(direct), Path(sys.executable))
        python = self.bin / "python3"
        python.symlink_to(sys.executable)
        via_env = self.bin / "via-env"
        via_env.write_text("#!/usr/bin/env -S python3 -u\n")
        with mock.patch.dict(os.environ, {"PATH": str(self.bin)}):
            self.assertEqual(sandbox.interpreter(via_env), python)
        self.assertEqual(sandbox.interpreter(Path(sys.executable)), Path(sys.executable))

    def test_the_python_brings_its_prefixes_and_import_path(self):
        read, start = sandbox.python_paths(sys.executable)
        self.assertIn(sys.base_prefix, read)
        self.assertIn(sys.prefix, read)
        self.assertTrue(any(str(p).endswith(("site-packages", "lib-dynload")) for p in read), read)
        self.assertIn(Path(sys.prefix) / "bin", start)

    def test_nothing_too_wide_is_ever_allowed(self):
        home = Path.home().resolve()
        self.assertEqual(sandbox._paths(["/", home, home.parent, self.root]), [self.root])

    def test_modes(self):
        for value, expected in (("0", "off"), ("off", "off"), ("report", "report"), ("1", "strict"), ("", "strict")):
            with mock.patch.dict(os.environ, {"VIDEO_SANDBOX": value}):
                self.assertEqual(sandbox.mode(), expected)

    def test_the_hint_names_report_mode_only_when_something_was_refused(self):
        with mock.patch.object(sandbox, "available", lambda: True), mock.patch.dict(os.environ, {"VIDEO_SANDBOX": "1"}):
            self.assertIn("VIDEO_SANDBOX=report", sandbox.hint("PermissionError: [Errno 1] Operation not permitted: '/x'"))
            self.assertEqual(sandbox.hint("NameError: name 'Foo' is not defined"), "")
            self.assertIn("sandbox_probe.py", sandbox.hint())
        with mock.patch.object(sandbox, "available", lambda: False):
            self.assertEqual(sandbox.hint("Operation not permitted"), "")


class ProbeTest(unittest.TestCase):
    """sandbox_probe.py's reading of the macOS log, on any platform."""

    def test_log_lines_become_narrow_rules(self):
        import sandbox_probe as probe
        m = probe.LINE.search("Sandbox: python3.12(4242) allow(1) file-read-data /opt/homebrew/etc/fonts/fonts.conf")
        self.assertEqual((m["proc"], m["verdict"], m["op"], m["target"]), ("python3.12", "allow", "file-read-data", "/opt/homebrew/etc/fonts/fonts.conf"))
        self.assertEqual(probe.rule_for(m["op"], m["target"]), '(allow file-read* (subpath "/opt/homebrew/etc/fonts"))')
        self.assertEqual(probe.rule_for("process-exec*", "/bin/sh"), '(allow process-exec* (literal "/bin/sh"))')
        self.assertEqual(probe.rule_for("mach-lookup", "com.apple.pasteboard.1"), '(allow mach-lookup (global-name "com.apple.pasteboard.1"))')
        mine = Path.home() / "Documents" / "notes" / "a.txt"
        self.assertEqual(probe.rule_for("file-read-data", str(mine)), f'(allow file-read* (literal "{mine}"))')  # never a folder of yours
        self.assertTrue(probe.OURS.match("dvisvgm") and not probe.OURS.match("Safari"))


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

    def test_the_profile_gets_the_build_folder_to_write_and_the_project_to_read(self):
        with mock.patch.object(sandbox, "available", lambda: True):
            args = sandbox.wrap([sys.executable], "/tmp/x")
        self.assertIn(f"BUILD={Path('/tmp/x/build').resolve()}", args)
        self.assertIn(f'(subpath "{Path("/tmp/x").resolve()}")', args[-2])
        self.assertEqual(args[-1], sys.executable)


if __name__ == "__main__":
    unittest.main()

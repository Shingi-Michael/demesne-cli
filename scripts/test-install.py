#!/usr/bin/env python3
"""Isolated Linux installer regression tests: python3 scripts/test-install.py.

No network, Bun, desktop session or installed app is required. All process IDs
belong to fixtures, and HOME, XDG paths and release assets are temporary.
"""
import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "install.sh"
PYTHON = sys.executable


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux installer fixtures")
class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="demesne-installer-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.tools = self.root / "tools"
        self.tools.mkdir()
        self.assets = self.root / "assets"
        self.assets.mkdir()
        # Regex metacharacters must stay literal in desktop process lookup.
        self.app = self.home / "app.[test]+"
        self.data = self.home / ".demesne"
        self.data.mkdir()
        (self.data / "sessions.fixture").write_text("keep me")
        self.env = {k: v for k, v in os.environ.items()
                    if not k.startswith("DEMESNE_") and k not in ("USER", "BASH_ENV", "ENV")}
        self.env.update(HOME=str(self.home), XDG_DATA_HOME=str(self.home / "share"),
                        DEMESNE_HOME=str(self.app), DEMESNE_RELEASE_URL="https://fixture.invalid",
                        FIXTURE_ASSETS=str(self.assets), FIXTURE_ROOT=str(self.root),
                        PATH=str(self.tools) + os.pathsep + os.environ["PATH"])
        self.tool("uname", '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n')
        self.tool("pgrep", '#!/bin/sh\nprintf "%s\\n" "$@" >"$FIXTURE_ROOT/pgrep.args"\nexit 1\n')
        # Do not refresh the real host's desktop caches.
        for name in ("update-desktop-database", "gtk-update-icon-cache"):
            self.tool(name, "#!/bin/sh\nexit 0\n")
        self.tool("curl", f'#!{PYTHON}\n' + '''import os, pathlib, shutil, sys, urllib.request
args = sys.argv[1:]
if "-o" in args:
    out = args[args.index("-o") + 1]
    name = args[-1].rsplit("/", 1)[-1]
    mode = os.environ.get("CHECKSUM_FAILURE", "") if name.endswith(".sha256") else ""
    if mode:
        print("curl: HTTP 404" if mode == "404" else "curl: network unavailable", file=sys.stderr)
        sys.exit(22 if mode == "404" else 7)
    shutil.copyfile(pathlib.Path(os.environ["FIXTURE_ASSETS"]) / name, out)
else:
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(args[-1], timeout=1) as r:
            sys.exit(0 if r.status == 200 else 22)
    except Exception:
        sys.exit(7)
''')
        self.bundle()

    def tool(self, name, content):
        path = self.tools / name
        path.write_text(content)
        path.chmod(0o755)

    def bundle(self, mode="healthy"):
        bundle = self.root / "demesne"
        bundle.mkdir(exist_ok=True)
        for name in ("demesne-desktop", "resources/backend/demesne-desktop-host"):
            path = bundle / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("#!/bin/sh\nexit 0\n")
            path.chmod(0o755)
        daemon = bundle / "resources/backend/demesned"
        daemon.write_text(f'#!{PYTHON}\nMODE = {mode!r}\n' + '''import http.server, os, pathlib, sys, time
pathlib.Path(os.environ["FIXTURE_ROOT"], "child.pid").write_text(str(os.getpid()))
if MODE == "exit":
    print("fixture startup failed", flush=True)
    sys.exit(1)
if MODE == "silent":
    time.sleep(60)
else:
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200 if MODE == "healthy" and self.path == "/healthz" else 503)
            self.end_headers()
        def log_message(self, *args): pass
    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    print(f"demesned fixture listening on http://127.0.0.1:{server.server_port}/", flush=True)
    server.serve_forever()
''')
        daemon.chmod(0o755)
        (bundle / "icon.png").write_bytes(b"fixture icon")
        self.archive = self.assets / "demesne-desktop-linux-x64.tar.gz"
        with tarfile.open(self.archive, "w:gz") as tar:
            tar.add(bundle, arcname="demesne")
        self.checksum = Path(str(self.archive) + ".sha256")
        self.checksum.write_text(hashlib.sha256(self.archive.read_bytes()).hexdigest() + "  " + self.archive.name + "\n")

    def run_installer(self, *args, piped=False):
        result = subprocess.run(["sh", "-s", "--", *args] if piped else ["sh", str(SCRIPT), *args],
                                input=SCRIPT.read_text() if piped else None,
                                env=self.env, text=True, capture_output=True, timeout=35)
        return result

    def assert_ok(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def running_upgrade(self, mode):
        self.assert_ok(self.run_installer())
        self.bundle(mode)
        old = subprocess.Popen([PYTHON, "-c", "import time; time.sleep(60)"],
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        def stop_old():
            if old.poll() is None:
                old.kill()
            old.wait(timeout=5)
        self.addCleanup(stop_old)
        self.addCleanup(lambda: self.stop_fixture_child())
        (self.data / "daemon.pid").write_text(str(old.pid))
        # Reap the old process as soon as the installer stops it, as a service
        # manager would. Otherwise kill -0 sees a zombie until the test waits.
        threading.Thread(target=old.wait, daemon=True).start()
        return old

    def stop_fixture_child(self):
        path = self.root / "child.pid"
        if path.exists():
            try:
                os.kill(int(path.read_text()), 9)
            except ProcessLookupError:
                pass

    def test_file_and_piped_help(self):
        for piped in (False, True):
            result = self.run_installer("--help", piped=piped)
            self.assert_ok(result)
            self.assertIn("--insecure-skip-checksum", result.stdout)
            self.assertIn("--version", result.stdout)
        self.assertFalse(self.app.exists())

    def test_install_upgrade_uninstall_without_user(self):
        self.assert_ok(self.run_installer(piped=True))
        self.assertTrue((self.app / "demesne-desktop").is_file())
        self.assertTrue((self.home / ".local/bin/demesne-desktop").is_symlink())
        desktop = self.home / "share/applications/demesne.desktop"
        self.assertIn(str(self.app / "demesne-desktop"), desktop.read_text())
        result = self.run_installer("--no-restart")
        self.assert_ok(result)
        self.assertNotIn("unbound", result.stderr)
        lookup = (self.root / "pgrep.args").read_text().splitlines()
        self.assertEqual(lookup[:3], ["-u", str(os.getuid()), "-f"])
        pattern = lookup[3]
        self.assertTrue(re.search(pattern, str(self.app / "demesne-desktop")))
        self.assertFalse(re.search(pattern, str(self.app / "demesne-desktop-host")))
        self.assertFalse(re.search(pattern, "editor " + str(self.app / "demesne-desktop")))
        self.assert_ok(self.run_installer("--uninstall"))
        self.assert_ok(self.run_installer("--uninstall"))
        self.assertFalse(self.app.exists())
        self.assertFalse(desktop.exists())
        self.assertEqual((self.data / "sessions.fixture").read_text(), "keep me")

    def test_checksum_failure_preserves_install(self):
        self.assert_ok(self.run_installer())
        sentinel = self.app / "existing-install"
        sentinel.write_text("old app")
        for failure in ("404", "network"):
            with self.subTest(failure=failure):
                self.env["CHECKSUM_FAILURE"] = failure
                result = self.run_installer()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("refusing unverified install", result.stderr)
                self.assertIn("404" if failure == "404" else "network unavailable", result.stderr)
                self.assertTrue(sentinel.exists())

    def test_checksum_mismatch(self):
        self.checksum.write_text("0" * 64 + "  " + self.archive.name + "\n")
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("checksum mismatch", result.stderr)
        self.assertFalse(self.app.exists())

    def test_explicit_insecure_override(self):
        self.env["CHECKSUM_FAILURE"] = "404"
        result = self.run_installer("--insecure-skip-checksum")
        self.assert_ok(result)
        self.assertIn("WARNING", result.stdout)

    def test_daemon_ready_on_nondefault_port(self):
        self.running_upgrade("healthy")
        result = self.run_installer()
        self.assert_ok(result)
        self.assertIn("restarted daemon", result.stdout)
        self.assertEqual((self.data / "daemon.pid").read_text().strip(),
                         (self.root / "child.pid").read_text())

    def test_no_restart_keeps_old_daemon(self):
        old = self.running_upgrade("exit")
        result = self.run_installer("--no-restart")
        self.assert_ok(result)
        self.assertIsNone(old.poll())
        self.assertFalse((self.root / "child.pid").exists())
        self.assertEqual((self.data / "daemon.pid").read_text(), str(old.pid))

    def test_daemon_exits_early(self):
        self.running_upgrade("exit")
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("restarted daemon", result.stdout)
        self.assertIn("fixture startup failed", result.stderr)
        self.assertFalse((self.data / "daemon.pid").exists())

    def test_daemon_never_healthy(self):
        self.running_upgrade("unhealthy")
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("failed to become healthy", result.stderr)
        self.assertNotIn("restarted daemon", result.stdout)
        self.assertFalse((self.data / "daemon.pid").exists())

    def test_stale_log_is_not_readiness(self):
        self.running_upgrade("silent")
        (self.data / "daemon.log").write_text("demesned old listening on http://127.0.0.1:1/\n")
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("restarted daemon", result.stdout)
        self.assertFalse((self.data / "daemon.pid").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)

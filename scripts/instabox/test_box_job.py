#!/usr/bin/env python3
"""Local regressions for box_job.py; no network, no Keychain. Fixtures live under the system temp directory."""

import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

sys.dont_write_bytecode = True
TOOL = Path(__file__).resolve().parent / "box_job.py"


class BoxJobTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="win7-eng06-boxjob-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.jobs, self.tmp, self.work = self.root / "jobs", self.root / "tmp", self.root / "work"
        self.work.mkdir()

    @staticmethod
    def kill_quietly(pid):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def run_tool(self, *args, check=True):
        done = subprocess.run([sys.executable, "-I", str(TOOL), *args], capture_output=True, text=True, timeout=60)
        if check:
            self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        return done

    def common(self, job):
        return ["--job-id", job, "--jobs-root", str(self.jobs), "--tmp-root", str(self.tmp)]

    def start(self, job, timeout, *command):
        done = self.run_tool("start", *self.common(job), "--timeout", str(timeout), "--workdir", str(self.work),
                             "--", *command)
        return json.loads(done.stdout)

    def status(self, job):
        return json.loads(self.run_tool("status", *self.common(job)).stdout)

    def wait_finished(self, job, seconds=30):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            state = self.status(job)
            if state["state"] != "RUNNING":
                return state
            time.sleep(0.2)
        self.fail("job did not finish")

    def test_start_returns_before_the_job_ends(self):
        began = time.monotonic()
        self.start("slow", 30, sys.executable, "-c", "import time; time.sleep(3)")
        self.assertLess(time.monotonic() - began, 2.5)
        self.assertEqual(self.status("slow")["state"], "RUNNING")
        self.assertEqual(self.wait_finished("slow")["result"]["exitCode"], 0)

    def test_supervisor_pid_exists_when_start_returns(self):
        started = self.start("fresh", 30, sys.executable, "-c", "import time; time.sleep(2)")
        self.assertEqual((self.jobs / "fresh" / "supervisor.pid").read_text().strip(), str(started["supervisorPid"]))
        self.assertEqual(self.status("fresh")["state"], "RUNNING")
        self.wait_finished("fresh")

    def test_normal_exit_records_result_logs_and_removes_tmpdir(self):
        code = "import os,sys; print('hello'); print(os.environ['TMPDIR'], file=sys.stderr); open(os.path.join(os.environ['TMPDIR'],'x'),'w').write('1')"
        self.start("ok", 30, sys.executable, "-c", code)
        state = self.wait_finished("ok")
        result = state["result"]
        self.assertEqual((state["state"], result["exitCode"], result["timedOut"], result["signal"]), ("FINISHED", 0, False, None))
        self.assertTrue(result["tmpdirRemoved"])
        self.assertFalse((self.tmp / "win7-job-ok").exists())
        self.assertEqual(result["stdout"]["bytes"], 6)
        self.assertEqual(result["stdout"]["sha256"], hashlib.sha256(b"hello\n").hexdigest())
        self.assertIn("win7-job-ok", (self.jobs / "ok" / "stderr.log").read_text())
        self.assertEqual(list((self.jobs / "ok").glob("*.tmp")), [])

    def test_nonzero_exit_is_recorded(self):
        self.start("bad", 30, sys.executable, "-c", "raise SystemExit(7)")
        self.assertEqual(self.wait_finished("bad")["result"]["exitCode"], 7)

    def test_timeout_kills_the_process_group(self):
        marker = self.root / "child-pid"
        code = ("import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); "
                f"open({str(marker)!r},'w').write(str(p.pid)); time.sleep(60)")
        self.start("late", 2, sys.executable, "-c", code)
        result = self.wait_finished("late", 60)["result"]
        self.assertTrue(result["timedOut"])
        self.assertEqual(result["signal"], "SIGTERM")
        self.assertTrue(result["tmpdirRemoved"])
        time.sleep(0.5)
        with self.assertRaises(ProcessLookupError):
            os.kill(int(marker.read_text()), 0)

    def test_missing_command_is_recorded_with_cleanup(self):
        self.start("nocmd", 30, "/nonexistent/command")
        result = self.wait_finished("nocmd")["result"]
        self.assertEqual(result["error"], "FileNotFoundError")
        self.assertTrue(result["tmpdirRemoved"])

    def test_killed_supervisor_reports_dead_without_result(self):
        marker = self.root / "job-pid"
        code = f"import os,time; open({str(marker)!r},'w').write(str(os.getpid())); time.sleep(60)"
        started = self.start("killed", 60, sys.executable, "-c", code)
        deadline = time.monotonic() + 10
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(0.1)
        orphan = int(marker.read_text())
        self.addCleanup(self.kill_quietly, orphan)
        os.kill(started["supervisorPid"], signal.SIGKILL)
        state = self.status("killed")
        self.assertEqual(state["state"], "DEAD_WITHOUT_RESULT")
        self.assertFalse((self.jobs / "killed" / "result.json").exists())
        # The orphaned command was never given a result; the cleanup above stops it.

    def test_collect_chunks_reassemble_with_matching_digest(self):
        self.start("big", 30, sys.executable, "-c", "import sys; sys.stdout.write('abcdefghij' * 5000)")
        self.wait_finished("big")
        data, offset = b"", 0
        while True:
            chunk = json.loads(self.run_tool("collect", *self.common("big"), "--file", "stdout.log",
                                              "--offset", str(offset), "--limit", "16384").stdout)
            piece = base64.b64decode(chunk["dataBase64"])
            self.assertEqual(hashlib.sha256(piece).hexdigest(), chunk["chunkSha256"])
            data += piece
            offset += len(piece)
            if offset >= chunk["size"]:
                break
        self.assertEqual(len(data), 50000)
        self.assertEqual(hashlib.sha256(data).hexdigest(), chunk["sha256"])
        tail = json.loads(self.run_tool("collect", *self.common("big"), "--file", "stdout.log", "--tail", "10").stdout)
        self.assertEqual(base64.b64decode(tail["dataBase64"]), b"abcdefghij")

    def test_collect_and_start_reject_unsafe_input(self):
        self.start("safe", 30, sys.executable, "-c", "print(1)")
        self.wait_finished("safe")
        (self.root / "secret").write_text("x")
        os.symlink(self.root / "secret", self.jobs / "safe" / "link.log")
        for name in ("../secret", "link.log", "missing.log", "a/b"):
            done = self.run_tool("collect", *self.common("safe"), "--file", name, check=False)
            self.assertEqual(done.returncode, 1, name)
        self.assertEqual(self.run_tool("start", *self.common("safe"), "--timeout", "5", "--workdir", str(self.work),
                                       "--", "true", check=False).returncode, 1)
        self.assertEqual(self.run_tool("status", *self.common("../x"), check=False).returncode, 1)
        self.assertEqual(self.status("never-started")["state"], "MISSING")


if __name__ == "__main__":
    unittest.main()

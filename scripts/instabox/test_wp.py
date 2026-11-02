#!/usr/bin/env python3
"""Offline tests for wp.py. The InstaBox API and GitHub are fakes; box_job.py and git run for real.

Fixtures live under the system temp directory with the win7-eng06- prefix and are removed in cleanup hooks.
"""

import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.parse

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import fingerprint  # noqa: E402
import wp  # noqa: E402
from cloud import Client, CloudError  # noqa: E402

TOOLS = Path(__file__).resolve().parent
TRANSPORT = "TRANSPORT_OR_JSON_ERROR_RECONCILE_BEFORE_RETRY"
BASE = "b" * 40
HEAD = "c" * 40
ORG = "org_test"
GOOD_G0 = "import json; print('[verify-timing] ' + json.dumps({'timings':[{'module':'workspace','status':0}]}))"
BAD_G0 = ("import json,sys; print('[verify-timing] ' + json.dumps({'timings':[{'module':'workspace','status':1}]})); "
          "sys.exit(1)")


class FakeGitHub:
    def __init__(self):
        self.calls, self.counter = [], 100

    def host_keys(self):
        return ["github.com ssh-ed25519 AAAATEST"]

    def add_key(self, title, public_key, read_only):
        self.counter += 1
        self.calls.append(("add", "read" if read_only else "write", self.counter))
        return self.counter

    def delete_key(self, key_id):
        self.calls.append(("delete", key_id))


class FakeApi:
    """Stands in for api.instabox.sh. Jobs run through the real box_job.py with stub commands."""

    def __init__(self, home):
        self.home = Path(home)
        self.machines, self.deleted, self.requests = {}, [], []
        self.uploads = {}
        self.slots = 5
        self.snapshot_status = "ready"
        self.t3 = {"wasInitiallyActive": True, "stopExitCode": 0, "after": "inactive", "cloudflaredExists": False}
        self.creds = {".claude/.credentials.json": {"sha256": "1" * 64, "bytes": 10, "permissions": "0o600", "mtimeNs": 1},
                      ".codex/auth.json": {"sha256": "2" * 64, "bytes": 10, "permissions": "0o600", "mtimeNs": 2}}
        self.work = {"head": HEAD, "dirty": False, "commits": 1}
        self.available = 20 * 1024 ** 3
        self.job_code = {"fetch": "pass", "prep": "pass", "emp": "print('done')", "g0": GOOD_G0, "push": "pass",
                         "prep-fp": "import json; print(json.dumps({'inputs': {'sha256': 'f' * 64}}))"}
        self.read_failures = 0
        self.generate_failures = 0
        self.corrupt = set()
        self.create_transport_error = False
        self.created = 0
        self.job_starts = []

    def machine_record(self, mid):
        m = self.machines[mid]
        return {"id": mid, "name": m["name"], "orgId": ORG, "state": "running", "runtime": {"ready": True}}

    def listing(self):
        return {"machines": [self.machine_record(m) for m in self.machines], "nextCursor": None}

    def request(self, method, route, payload=None, headers=None, timeout=40):
        self.requests.append((method, route))
        path = route.split("?")[0]
        if method == "GET" and path == "machines":
            return self.listing()
        if method == "GET" and path == "usage":
            return {"limits": {"maxMachines": self.slots}}
        if method == "GET" and path.startswith("snapshots/"):
            return {"id": path.split("/")[1], "status": self.snapshot_status, "orgId": ORG}
        if method == "POST" and path == "machines":
            self.created += 1
            mid = "m_test%d" % self.created
            self.machines[mid] = {"name": payload["name"]}
            if self.create_transport_error:
                self.create_transport_error = False
                raise CloudError(TRANSPORT)
            return {"id": "op_create%d" % self.created, "machineId": mid, "state": "succeeded"}
        if method == "GET" and path.startswith("operations/"):
            return {"id": path.split("/")[1], "state": "succeeded"}
        match = path.split("/")
        if match[0] == "machines" and len(match) >= 2:
            mid = match[1]
            tail = "/".join(match[2:])
            if method == "GET" and not tail:
                return self.machine_record(mid)
            if method == "DELETE" and not tail:
                self.deleted.append(mid)
                del self.machines[mid]
                return {"id": "op_delete", "state": "succeeded"}
            if method == "PUT" and tail == "files":
                self.uploads[route] = payload
                return {}
            if method == "PUT" and tail.startswith("activity-leases/"):
                return {"id": match[3], "machineId": mid, "expiresAt": "2099-01-01T00:00:00Z"}
            if method == "GET" and tail == "disk":
                return {"filesystems": [{"mount": "/data", "availableBytes": self.available}]}
            if method == "POST" and tail == "exec":
                return self.execute(payload["argv"])
        raise AssertionError("unexpected request %s %s" % (method, route))

    def execute(self, argv):
        if argv[0].endswith("box-job.sh"):
            return self.box_job(argv[1:])
        script = argv[2]
        if argv[:2] == ["python3", "-c"]:
            if script == wp.STOP_T3:
                return self.ok(json.dumps(self.t3))
            if script == wp.CREDENTIAL_META:
                return self.ok(json.dumps(self.creds))
        if argv[:2] == ["bash", "-c"]:
            if script == wp.GENERATE_KEY:
                if self.generate_failures > 0:
                    self.generate_failures -= 1
                    raise CloudError(TRANSPORT)
                return self.ok("ssh-ed25519 AAAATESTPUBLIC wp-test\n")
            if script == wp.REMOVE_KEY:
                return self.ok("")
            if script == wp.WORK_STATE:
                return self.ok(json.dumps(self.work))
        raise AssertionError("unexpected command " + argv[0])

    @staticmethod
    def ok(stdout, code=0):
        return {"stdout": stdout, "stderr": "", "exitCode": code, "timedOut": False, "truncated": False, "oomKilled": False}

    def box_job(self, args):
        verb = args[0]
        if verb in ("status", "collect") and self.read_failures > 0:
            self.read_failures -= 1
            raise CloudError(TRANSPORT)
        args = list(args)
        if verb == "start":
            self.job_starts.append(list(args))
            job_id = args[args.index("--job-id") + 1]
            Path(args[args.index("--workdir") + 1]).mkdir(parents=True, exist_ok=True)
            cut = args.index("--")
            prefix = job_id.rsplit("-t1", 1)[0]
            args = args[:cut] + ["--", sys.executable, "-c", self.job_code.get(prefix, "pass")]
        environment = dict(os.environ, BOX_JOBS_ROOT=str(self.home / "jobs"), BOX_TMP_ROOT=str(self.home / "tmp"))
        done = subprocess.run([sys.executable, "-I", str(TOOLS / "box_job.py"), *args], capture_output=True,
                              text=True, env=environment, timeout=60)
        stdout = done.stdout
        if verb == "collect":
            job_id, name = args[args.index("--job-id") + 1], args[args.index("--file") + 1]
            if (job_id, name) in self.corrupt:
                chunk = json.loads(stdout)
                chunk["dataBase64"] = base64.b64encode(b"tampered").decode()
                stdout = json.dumps(chunk)
        return self.ok(stdout, done.returncode)


class WorkPackageBase(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="win7-eng06-wp-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.home = self.root / "home"
        self.home.mkdir()
        self.api = FakeApi(self.home)
        self.client = Client.__new__(Client)
        self.client.account = {"alias": "czl", "expectedOrgId": ORG}
        self.client.request = self.api.request
        self.github = FakeGitHub()
        self.package = wp.Package(self.root / "wp", "t1")

    def local(self, argv, cwd, timeout):
        if argv[:2] == ["git", "ls-remote"]:
            out = "%s\trefs/heads/main\n" % BASE
            if len(argv) > 3:
                out = "%s\t%s\n" % (HEAD, argv[3])
            return subprocess.CompletedProcess(argv, 0, stdout=out, stderr="")
        raise AssertionError("unexpected local command " + " ".join(argv))

    def make(self, home=None):
        return wp.Wp(self.client, self.github, self.package, "git@example.invalid:x.git", sleep=lambda s: time.sleep(0.05),
                     home=str(home or self.home), run_local=self.local, mac_remote="staging-remote")

    def open_package(self):
        runner = self.make()
        runner.open("t1", BASE, "sn_test", ["src/workspace/"])
        return runner

    def finish_employee(self, runner, agent="codex"):
        sheet = self.root / "TASK.md"
        sheet.write_text("task")
        runner.run(agent, sheet, ["Bash(git:*)"], ["workspace"])
        deadline = time.monotonic() + 30
        while runner.job_status("emp-t1")["state"] == "RUNNING" and time.monotonic() < deadline:
            time.sleep(0.1)


class OpenTests(WorkPackageBase):
    def test_open_follows_the_documented_order_and_revokes_the_read_key(self):
        runner = self.open_package()
        state = self.package.load()
        self.assertEqual((state["state"], state["machineName"]), ("OPENED", "wp-t1"))
        self.assertEqual(state["workerFingerprint"], "f" * 64)
        self.assertEqual([c[0] for c in self.github.calls], ["add", "delete"])
        self.assertEqual(self.github.calls[0][1], "read")
        self.assertIsNotNone(state["keys"]["read"]["revokedAt"])
        paths = [r for m, r in self.api.requests if m == "PUT" and "files" in r]
        self.assertEqual(len(paths), 4)  # three tools plus known_hosts
        self.assertEqual(self.api.deleted, [])
        self.assertTrue((self.package.directory / "collected" / "fetch-t1" / "result.json").exists())
        self.assertTrue(any(name.endswith("-t3-stopped.json") for name in os.listdir(self.package.directory)))
        self.assertTrue(runner.s["credentialsBaseline"])

    def test_pre_checks_leave_no_task_directory(self):
        self.api.slots = 1
        self.api.machines["m_other"] = {"name": "other"}
        with self.assertRaisesRegex(wp.WpError, "NO_MACHINE_SLOT"):
            self.make().open("t1", BASE, "sn_test", [])
        self.assertFalse(self.package.directory.exists())
        self.api.slots = 5
        self.api.snapshot_status = "creating"
        with self.assertRaisesRegex(wp.WpError, "SNAPSHOT_NOT_READY"):
            self.make().open("t1", BASE, "sn_test", [])
        self.assertEqual(self.api.created, 0)

    def test_lost_create_receipt_is_reconciled_by_name_without_a_second_create(self):
        self.api.create_transport_error = True
        self.open_package()
        self.assertEqual(self.api.created, 1)
        self.assertEqual(self.package.load()["machineId"], "m_test1")

    def test_running_t3_aborts_and_deletes_the_machine(self):
        self.api.t3["after"] = "active"
        with self.assertRaisesRegex(wp.WpError, "T3_NOT_STOPPED"):
            self.open_package()
        self.assertEqual(self.api.deleted, ["m_test1"])
        self.assertEqual(self.package.load()["state"], "ABORTED")

    def test_low_disk_aborts_before_any_key_exists(self):
        self.api.available = 1024 ** 3
        with self.assertRaisesRegex(wp.WpError, "DISK_TOO_SMALL"):
            self.open_package()
        self.assertEqual((self.api.deleted, self.github.calls), (["m_test1"], []))

    def test_failed_fetch_job_keeps_logs_deletes_machine_and_still_revokes_key(self):
        self.api.job_code["fetch"] = "import sys; print('boom', file=sys.stderr); sys.exit(2)"
        with self.assertRaisesRegex(wp.WpError, "OPEN_JOB_FAILED_FETCH"):
            self.open_package()
        self.assertEqual([c[0] for c in self.github.calls], ["add", "delete"])
        self.assertIn("boom", (self.package.directory / "collected" / "fetch-t1" / "stderr.log").read_text())
        self.assertEqual(self.api.deleted, ["m_test1"])

    def test_lost_key_generation_reply_is_retried_and_the_key_is_registered_once(self):
        self.api.generate_failures = 2
        self.open_package()
        self.assertEqual([c[:2] for c in self.github.calls], [("add", "read"), ("delete", 101)])
        self.assertTrue(any(name.endswith("idempotent-retries.json") for name in os.listdir(self.package.directory)))

    def test_open_resumes_on_the_same_machine_after_a_persistent_failure(self):
        self.api.generate_failures = 100
        with self.assertRaises(CloudError):
            self.open_package()
        self.assertEqual((self.api.created, self.api.deleted, self.package.load()["state"]), (1, [], "OPENING"))
        self.assertEqual(self.package.state["openStep"], "uploaded")
        self.api.generate_failures = 0
        self.make_loaded().resume_open()
        self.assertEqual((self.package.load()["state"], self.api.created, self.api.deleted), ("OPENED", 1, []))
        with self.assertRaisesRegex(wp.WpError, "NOTHING_TO_RESUME"):
            self.make_loaded().resume_open()

    def make_loaded(self):
        self.package.load()
        return self.make()

    def test_read_failures_during_open_are_retried_and_recorded(self):
        self.api.read_failures = 2
        self.open_package()
        self.assertTrue(any(name.endswith("read-retries.json") for name in os.listdir(self.package.directory)))


class CloseTests(WorkPackageBase):
    def prepared(self, **kwargs):
        runner = self.open_package()
        self.finish_employee(runner)
        return runner

    def test_close_pushes_with_a_one_time_key_then_deletes_the_machine(self):
        runner = self.prepared()
        result = runner.close()
        self.assertEqual((result["state"], result["machineKept"], result["g0"]), ("PUSHED", False, "PASS"))
        self.assertEqual([c[:2] for c in self.github.calls], [("add", "read"), ("delete", 101), ("add", "write"), ("delete", 102)])
        self.assertEqual(self.api.deleted, ["m_test1"])
        state = self.package.load()
        self.assertEqual((state["state"], state["pushedCommit"], state["machineDeleted"]), ("PUSHED", HEAD, True))
        self.assertIsNotNone(state["keys"]["write"]["revokedAt"])

    def test_unreadable_result_keeps_the_machine(self):
        runner = self.prepared()
        self.api.corrupt.add(("g0-t1", "stdout.log"))
        with self.assertRaisesRegex(wp.WpError, "COLLECT_FAILED_MACHINE_KEPT"):
            runner.close()
        self.assertEqual(self.api.deleted, [])
        self.assertEqual(self.package.load()["state"], "COLLECT_FAILED")
        self.assertEqual([c for c in self.github.calls if c[1] == "write"], [])

    def test_changed_credentials_hold_the_machine_until_the_owner_decides(self):
        runner = self.prepared()
        self.api.creds[".codex/auth.json"]["sha256"] = "9" * 64
        held = runner.close()
        self.assertEqual((held["state"], held["machineKept"]), ("CREDENTIALS_HOLD", True))
        self.assertEqual(self.api.deleted, [])
        self.assertEqual(self.package.load()["resumeState"], "PUSHED")
        again = self.make_loaded().close()
        self.assertEqual((again["state"], self.api.deleted), ("CREDENTIALS_HOLD", []))
        released = self.make_loaded().close(discard_credentials=True)
        self.assertEqual((released["state"], released["machineKept"], released["commit"]), ("PUSHED", False, HEAD))
        self.assertEqual(self.api.deleted, ["m_test1"])
        with self.assertRaisesRegex(wp.WpError, "ALREADY_CLOSED"):
            self.make_loaded().close()

    def make_loaded(self):
        self.package.load()
        return self.make()

    def test_uncommitted_work_keeps_the_machine(self):
        runner = self.prepared()
        self.api.work = {"head": HEAD, "dirty": True, "commits": 1}
        with self.assertRaisesRegex(wp.WpError, "UNCOMMITTED_CHANGES_MACHINE_KEPT"):
            runner.close()
        self.assertEqual(self.api.deleted, [])

    def test_no_commits_deletes_the_machine_without_a_write_key(self):
        runner = self.prepared()
        self.api.work = {"head": BASE, "dirty": False, "commits": 0}
        result = runner.close()
        self.assertEqual((result["state"], result["commit"]), ("FAILED", None))
        self.assertEqual(self.api.deleted, ["m_test1"])
        self.assertEqual([c for c in self.github.calls if c[1] == "write"], [])

    def test_failing_g0_still_pushes_and_marks_the_package_failed(self):
        self.api.job_code["g0"] = BAD_G0
        runner = self.prepared()
        result = runner.close()
        self.assertEqual((result["state"], result["g0"]), ("FAILED", "FAIL"))
        self.assertEqual(self.package.load()["pushedCommit"], HEAD)

    def test_close_refuses_while_the_employee_is_running(self):
        self.api.job_code["emp"] = "import time; time.sleep(30)"
        runner = self.open_package()
        sheet = self.root / "TASK.md"
        sheet.write_text("task")
        runner.run("claude", sheet, [], [])
        with self.assertRaisesRegex(wp.WpError, "EMPLOYEE_NOT_FINISHED"):
            runner.close()
        report = runner.poll()
        self.assertEqual((report["employee"], report["warning"]), ("RUNNING", None))
        subprocess.run(["pkill", "-f", "box_job.py _supervise --job-id emp-t1"], check=False)

    def test_unknown_module_is_rejected_before_g0(self):
        runner = self.prepared()
        runner.s["modules"] = ["../x"]
        with self.assertRaisesRegex(wp.WpError, "INVALID_MODULE"):
            runner.close()


class CommitTests(WorkPackageBase):
    def manifest(self, runner):
        path = self.root / "manifest.json"
        path.write_text(json.dumps({"schemaVersion": 1, "base": BASE, "branch": "box/t1",
                                   "subject": "test wrapper commit", "files": [
                                       {"path": "src/workspace/probe.txt", "sha256": "a" * 64, "mode": "100644"}]}),
                        encoding="utf-8")
        return path

    def test_wrapper_commits_once_without_write_key(self):
        runner = self.open_package()
        self.finish_employee(runner)
        manifest = self.manifest(runner)
        def output(name, argv):
            self.assertEqual(name, "commit")
            self.api.work = {"head": HEAD, "dirty": False, "commits": 1}
            return {"status": "COMMITTED", "commit": HEAD, "manifestSha256": wp.digest(manifest.read_bytes())}
        runner.job_output = output
        result = runner.commit(manifest)
        self.assertEqual(result["commit"], HEAD)
        self.assertEqual(runner.s["wrapperCommit"], HEAD)
        self.assertFalse(any(call[:2] == ("add", "write") for call in self.github.calls))
        with self.assertRaisesRegex(wp.WpError, "COMMIT_ALREADY_STARTED"):
            runner.commit(manifest)
        runner.close()

    def test_credentials_change_stops_before_commit_or_push(self):
        runner = self.open_package()
        self.finish_employee(runner)
        manifest = self.manifest(runner)
        self.api.creds[".codex/auth.json"]["mtimeNs"] += 1
        with self.assertRaisesRegex(wp.WpError, "CREDENTIALS_HOLD_BEFORE_COMMIT"):
            runner.commit(manifest)
        self.assertEqual(runner.s["state"], "CREDENTIALS_HOLD")
        self.assertNotIn("commitStartedAt", runner.s)
        with self.assertRaisesRegex(wp.WpError, "UNCOMMITTED_CREDENTIALS_HOLD"):
            runner.close(discard_credentials=True)
        self.assertEqual(self.api.deleted, [])

    def test_manifest_outside_package_scope_is_rejected(self):
        runner = self.open_package()
        self.finish_employee(runner)
        manifest = self.manifest(runner)
        data = json.loads(manifest.read_text())
        data["files"][0]["path"] = "src/gateway/unapproved.txt"
        manifest.write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaisesRegex(wp.WpError, "COMMIT_MANIFEST_OUT_OF_SCOPE"):
            runner.commit(manifest)
        self.assertNotIn("commitStartedAt", runner.s)


class ReviewTests(WorkPackageBase):
    def test_codex_preserves_sandbox_without_git_metadata_write_argument(self):
        folder = self.root / "package with spaces"
        folder.mkdir()
        (folder / "TASK.md").write_text("one-file task", encoding="utf-8")
        stub = self.root / "codex"
        stub.write_text('#!/bin/bash\nprintf "%s\\n" "$@"\n', encoding="utf-8")
        stub.chmod(0o755)
        environment = dict(os.environ, PATH=str(self.root) + os.pathsep + os.environ["PATH"])
        for mode in ("workspace-write", "read-only"):
            done = subprocess.run(wp.bash(wp.CODEX, str(folder), mode), env=environment,
                                  capture_output=True, text=True, check=True, timeout=10)
            argv = done.stdout.splitlines()
            self.assertNotIn("--add-dir", argv)
            self.assertEqual(argv[argv.index("--sandbox") + 1], mode)

    TOKEN = b"sk-ant-oat01-" + b"T" * 48

    def test_claude_script_reads_the_token_file_then_deletes_it(self):
        folder = self.root / "package with spaces"
        folder.mkdir()
        (folder / "work").mkdir()
        (folder / "TASK.md").write_text("one-file task", encoding="utf-8")
        stub = self.root / "claude"
        stub.write_text('#!/bin/bash\nprintf "token=%s\\n" "${CLAUDE_CODE_OAUTH_TOKEN:-unset}"\nprintf "%s\\n" "$@"\n',
                        encoding="utf-8")
        stub.chmod(0o755)
        environment = dict(os.environ, PATH=str(self.root) + os.pathsep + os.environ["PATH"])
        environment.pop("CLAUDE_CODE_OAUTH_TOKEN", None)
        secret = self.root / "secret dir" / "claude-oauth-token"
        secret.parent.mkdir()
        secret.write_bytes(self.TOKEN)
        done = subprocess.run(wp.bash(wp.CLAUDE, str(folder), "plan", str(secret), "--disallowedTools", "Edit"),
                              env=environment, capture_output=True, text=True, check=True, timeout=10)
        lines = done.stdout.splitlines()
        self.assertEqual(lines[0], "token=" + self.TOKEN.decode())
        self.assertEqual(lines[lines.index("--permission-mode") + 1], "plan")
        self.assertIn("--disallowedTools", lines)
        self.assertNotIn(str(secret), lines)
        self.assertFalse(secret.exists())
        missing = subprocess.run(wp.bash(wp.CLAUDE, str(folder), "plan", str(secret)), env=environment,
                                 capture_output=True, text=True, timeout=10)
        self.assertEqual((missing.returncode, missing.stdout), (97, ""))
        self.assertIn("WP_CLAUDE_TOKEN_MISSING", missing.stderr)
        login = subprocess.run(wp.bash(wp.CLAUDE, str(folder), "plan", "login"), env=environment,
                               capture_output=True, text=True, check=True, timeout=10)
        self.assertEqual(login.stdout.splitlines()[0], "token=unset")

    def token_review(self):
        runner = self.open_package()
        runner.claude_token, runner.claude_token_account = self.TOKEN, "czl-claude"
        self.api.work = {"head": BASE, "dirty": False, "commits": 0}
        sheet = self.root / "TASK.md"
        sheet.write_text("Reply OK.", encoding="utf-8")
        runner.run("claude", sheet, mode="review", timeout=300)
        runner.wait_job("emp-t1", 30, interval=0.05)
        return runner

    def test_claude_token_is_uploaded_private_and_kept_out_of_records(self):
        runner = self.token_review()
        path = str(self.home) + "/.wp-secrets/claude-oauth-token"
        uploads = [(route, data) for route, data in self.api.uploads.items()
                   if "path=" + urllib.parse.quote(path, safe="") + "&" in route]
        self.assertEqual(len(uploads), 1)
        self.assertIn("mode=0600", uploads[0][0])
        self.assertEqual(uploads[0][1], self.TOKEN)
        self.assertIn(path, self.api.job_starts[-1])
        self.assertEqual((self.package.state["claudeAuth"], self.package.state["claudeTokenAccount"]),
                         ("CLAUDE_CODE_OAUTH_TOKEN", "czl-claude"))
        self.assertEqual(runner.close()["state"], "CLOSED")
        self.assertIs(self.package.state["claudeTokenInPackageFiles"], False)
        for item in self.package.directory.rglob("*"):
            if item.is_file():
                self.assertNotIn(self.TOKEN, item.read_bytes(), str(item))

    def test_token_in_a_collected_log_fails_and_keeps_the_machine(self):
        self.api.job_code["emp"] = "print('sk-ant-oat01-' + 'T' * 48)"
        runner = self.token_review()
        with self.assertRaisesRegex(wp.WpError, "CLAUDE_TOKEN_IN_PACKAGE_FILES_MACHINE_KEPT"):
            runner.close()
        self.assertEqual(self.api.deleted, [])
        self.assertEqual((self.package.state["state"], self.package.state["tokenHits"]),
                         ("FAILED", ["collected/emp-t1/stdout.log"]))

    def test_token_mode_without_the_keychain_value_refuses_to_close(self):
        runner = self.token_review()
        runner.claude_token = None
        with self.assertRaisesRegex(wp.WpError, "CLAUDE_TOKEN_UNAVAILABLE_FOR_LEAK_CHECK"):
            runner.close()
        self.assertEqual(self.api.deleted, [])

    def test_snapshot_login_mode_is_recorded_without_a_token_upload(self):
        runner, _ = self.prepared_review()
        self.assertEqual(self.package.state["claudeAuth"], "SNAPSHOT_LOGIN")
        self.assertFalse(any("wp-secrets" in route for route in self.api.uploads))
        self.assertIn("login", self.api.job_starts[-1])
        runner.close()

    def prepared_review(self, agent="claude"):
        runner = self.open_package()
        self.api.work = {"head": BASE, "dirty": False, "commits": 0}
        sheet = self.root / "TASK.md"
        sheet.write_text("Review only; report P0/P1.", encoding="utf-8")
        runner.run(agent, sheet, ["Read", "Bash(git show:*)"], mode="review", timeout=900)
        runner.wait_job("emp-t1", 30, interval=0.05)
        return runner, sheet

    def test_review_closes_without_g0_push_or_write_key(self):
        runner, _ = self.prepared_review()
        result = runner.close()
        self.assertEqual((result["state"], result["g0"], result["commit"]), ("CLOSED", "N/A", None))
        self.assertEqual([call[:2] for call in self.github.calls], [("add", "read"), ("delete", 101)])
        self.assertEqual(self.api.deleted, ["m_test1"])
        self.assertEqual([args[args.index("--job-id") + 1] for args in self.api.job_starts],
                         ["fetch-t1", "prep-t1", "prep-fp-t1", "emp-t1"])
        employee = self.api.job_starts[-1]
        self.assertEqual(employee[employee.index("--timeout") + 1], "900")
        self.assertIn("plan", employee)
        self.assertIn("Edit,Write,NotebookEdit", employee)
        self.assertIn("--verbose", wp.CLAUDE)

    def test_codex_review_uses_read_only_and_cannot_restart_the_employee(self):
        runner, sheet = self.prepared_review("codex")
        self.assertEqual(self.api.job_starts[-1][-1], "read-only")
        with self.assertRaisesRegex(wp.WpError, "EMPLOYEE_ALREADY_STARTED"):
            runner.run("codex", sheet, mode="review", timeout=900)
        runner.close()

    def test_review_rejects_direct_write_key_and_push_calls(self):
        runner, _ = self.prepared_review()
        for action, message in ((lambda: runner.with_key("write", lambda: None), "REVIEW_WRITE_KEY_FORBIDDEN"),
                                (runner.push, "REVIEW_PUSH_FORBIDDEN")):
            with self.assertRaisesRegex(wp.WpError, message):
                action()
        runner.close()

    def test_review_collect_failure_keeps_machine_without_write_key(self):
        runner, _ = self.prepared_review()
        self.api.corrupt.add(("emp-t1", "stdout.log"))
        with self.assertRaisesRegex(wp.WpError, "COLLECT_FAILED_MACHINE_KEPT"):
            runner.close()
        self.assertEqual(self.api.deleted, [])
        self.assertEqual([call for call in self.github.calls if call[1] == "write"], [])

    def test_review_changed_repository_is_not_deleted_or_pushed(self):
        runner, _ = self.prepared_review()
        self.api.work = {"head": HEAD, "dirty": False, "commits": 1}
        with self.assertRaisesRegex(wp.WpError, "REVIEW_WORKSPACE_CHANGED_MACHINE_KEPT"):
            runner.close()
        self.assertEqual((self.api.deleted, self.package.state["state"]), ([], "FAILED"))

    def test_review_credential_change_holds_until_owner_decision(self):
        runner, _ = self.prepared_review()
        self.api.creds[".claude/.credentials.json"]["mtimeNs"] = 3
        self.assertEqual(runner.close()["state"], "CREDENTIALS_HOLD")
        self.assertEqual(self.api.deleted, [])
        self.assertEqual(runner.close()["state"], "CREDENTIALS_HOLD")
        self.assertEqual(runner.close(discard_credentials=True)["state"], "CLOSED")
        self.assertEqual(self.api.deleted, ["m_test1"])

    def test_nonzero_review_exit_is_failed_after_logs_are_collected(self):
        self.api.job_code["emp"] = "import sys; print('failed'); sys.exit(2)"
        runner, _ = self.prepared_review()
        self.assertEqual(runner.close()["state"], "FAILED")
        self.assertEqual(self.api.deleted, ["m_test1"])
        self.assertTrue((self.package.directory / "collected/emp-t1/stdout.log").exists())


class ReceiveTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="win7-eng06-wp-g1-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.repo, self.stage, self.emp = self.root / "main", self.root / "stage.git", self.root / "emp"
        self.repo.mkdir()
        self.g(self.repo, "init", "-q", "-b", "main")
        for name in fingerprint.INPUTS + ("docs/STATUS.md", "src/workspace/a.ts", "README.md"):
            (self.repo / name).parent.mkdir(parents=True, exist_ok=True)
            (self.repo / name).write_text(name + "\n")
        self.g(self.repo, "add", "-A")
        self.g(self.repo, "commit", "-q", "-m", "base")
        self.base = self.g(self.repo, "rev-parse", "HEAD").strip()
        subprocess.run(["git", "init", "-q", "--bare", str(self.stage)], check=True)
        self.g(self.repo, "push", "-q", str(self.stage), "main")
        listing = subprocess.run(["git", "ls-remote", str(self.stage)], capture_output=True, text=True, check=True).stdout
        self.refs_before = {line.split("\t")[1]: line.split("\t")[0] for line in listing.splitlines()}
        self.calls = []

    @staticmethod
    def g(cwd, *args):
        done = subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", *args], cwd=str(cwd),
                              capture_output=True, text=True)
        assert done.returncode == 0, done.stderr
        return done.stdout

    def employee_commit(self, files, branch="box/t1"):
        self.g(self.root, "clone", "-q", str(self.stage), str(self.emp))
        self.g(self.emp, "checkout", "-q", "-b", branch)
        for name, text in files.items():
            (self.emp / name).parent.mkdir(parents=True, exist_ok=True)
            (self.emp / name).write_text(text)
        self.g(self.emp, "add", "-A")
        self.g(self.emp, "commit", "-q", "-m", "work")
        self.g(self.emp, "push", "-q", "origin", branch)
        return self.g(self.emp, "rev-parse", "HEAD").strip()

    def local(self, argv, cwd, timeout):
        if argv[0] in ("npm", "node"):
            self.calls.append(argv)
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")
        done = subprocess.run(argv, cwd=str(cwd), capture_output=True, text=True, timeout=timeout)
        return done

    def receive(self, tip, **state):
        package = wp.Package(self.root / "out", "t1")
        package.create()
        package.state = {"task": "t1", "account": "czl", "machineName": "wp-t1", "snapshotId": "sn_x", "base": self.base,
                         "allowedPaths": ["src/workspace/"], "refsBefore": self.refs_before, "pushedCommit": tip,
                         "workerFingerprint": fingerprint.input_fingerprint(self.repo)["sha256"],
                         "keys": {}, "g0": {"result": "PASS"}, "credentialsChanged": False}
        package.state.update(state)
        package.save()
        runner = wp.Wp(None, None, package, "git@example.invalid:x.git", run_local=self.local, repo_root=self.repo,
                       mac_remote=str(self.stage))
        return runner.receive(), package

    def test_clean_package_passes_every_check_and_leaves_no_worktree(self):
        tip = self.employee_commit({"src/workspace/a.ts": "changed\n"})
        receipt, package = self.receive(tip)
        self.assertEqual(receipt["overall"], "PASS", receipt)
        self.assertEqual(package.state["state"], "CLOSED")
        self.assertEqual(self.calls[0][:3], ["npm", "run", "docs:check"])
        self.assertEqual(self.calls[1][-2:], ["--module", "workspace"])
        self.assertEqual(len((self.root / "out" / "ledger.jsonl").read_text().splitlines()), 1)
        self.assertEqual(len(self.g(self.repo, "worktree", "list").strip().splitlines()), 1)
        self.assertEqual(list(Path(tempfile.gettempdir()).glob("win7-eng06-g1-*")), [])

    def test_task_selected_module_runs_even_when_only_the_verifier_changed(self):
        tip = self.employee_commit({"scripts/verify_integration.mjs": "// D9 probe\n"})
        receipt, _ = self.receive(tip, allowedPaths=["scripts/verify_integration.mjs"], modules=["workspace"])
        self.assertEqual(receipt["overall"], "PASS", receipt)
        self.assertEqual(self.calls[1][-2:], ["--module", "workspace"])

    def test_change_outside_scope_or_in_shared_docs_fails_and_skips_later_checks(self):
        tip = self.employee_commit({"docs/STATUS.md": "edited\n", "README.md": "x\n"})
        receipt, package = self.receive(tip)
        self.assertEqual(receipt["checks"]["changedPathsInScope"]["result"], "FAIL")
        self.assertEqual(receipt["checks"]["docsCheck"]["result"], "NOT_PERFORMED")
        self.assertEqual((receipt["overall"], package.state["state"], self.calls), ("FAIL", "G1_FAILED", []))

    def test_secret_in_the_diff_fails(self):
        tip = self.employee_commit({"src/workspace/a.ts": "const k = 'ibk_" + "a" * 32 + "';\n"})
        receipt, _ = self.receive(tip)
        self.assertEqual(receipt["checks"]["secretScan"], {"result": "FAIL", "matchingLines": 1})

    def test_extra_branch_in_staging_fails_the_reference_check(self):
        tip = self.employee_commit({"src/workspace/a.ts": "changed\n"})
        self.g(self.emp, "push", "-q", "origin", "HEAD:refs/heads/other")
        receipt, _ = self.receive(tip)
        self.assertEqual(receipt["checks"]["stagingRefsOnlyBranchAdded"]["result"], "FAIL")

    def test_moved_base_branch_fails_the_reference_check(self):
        tip = self.employee_commit({"src/workspace/a.ts": "changed\n"})
        self.g(self.emp, "push", "-q", "-f", "origin", "HEAD:refs/heads/main")
        receipt, _ = self.receive(tip)
        self.assertEqual(receipt["checks"]["stagingRefsOnlyBranchAdded"]["result"], "FAIL")

    def test_branch_not_rooted_at_the_base_fails_the_chain_check(self):
        other = self.root / "orphan"
        subprocess.run(["git", "init", "-q", "-b", "box/t1", str(other)], check=True)
        (other / "f").write_text("x")
        self.g(other, "add", "-A")
        self.g(other, "commit", "-q", "-m", "orphan")
        self.g(other, "push", "-q", str(self.stage), "box/t1")
        tip = self.g(other, "rev-parse", "HEAD").strip()
        receipt, _ = self.receive(tip)
        self.assertEqual(receipt["checks"]["parentChainStartsAtBase"]["result"], "FAIL")

    def test_fingerprint_mismatch_fails(self):
        tip = self.employee_commit({"src/workspace/a.ts": "changed\n"})
        receipt, _ = self.receive(tip, workerFingerprint="0" * 64)
        self.assertEqual(receipt["checks"]["fingerprintMatches"]["result"], "FAIL")

    def test_push_that_differs_from_the_recorded_commit_fails(self):
        tip = self.employee_commit({"src/workspace/a.ts": "changed\n"})
        receipt, _ = self.receive(tip, pushedCommit="d" * 40)
        self.assertEqual(receipt["checks"]["tipMatchesPush"]["result"], "FAIL")


if __name__ == "__main__":
    unittest.main()

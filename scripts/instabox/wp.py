#!/usr/bin/env python3
"""Work-package orchestration on the Mac (design r4 sections 4.2 and 6.2).

open     machine from the login snapshot, T3 stopped, read key used and revoked, checkout, prepare
run      upload the task sheet and start the employee as a background job
poll     read job state and disk, renew the lease
commit   verify a Mac-supplied exact manifest and create one local commit after the employee exits
close    G0 on the machine, collect and verify every file, push with a one-time write key, delete the machine
receive  G1 on the Mac: reference check, ancestry, paths, secret scan, fingerprint, docs:check, module tests

Rules kept from the earlier probes: a plan receipt is written before each remote change; a transport error
on a change is reconciled by reading state, never resent; the machine is deleted only after every result
file is collected and its SHA-256 matches.
"""

import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import uuid

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from cloud import Client, CloudError  # noqa: E402
import fingerprint  # noqa: E402

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent.parent
TASK_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,23}\Z")
COMMIT = re.compile(r"[0-9a-f]{40}\Z")
HOME = "/data/home"
DEFAULT_REPO = "allin2/win7-coding-agent-staging"
EMPLOYEE_SECONDS = 180 * 60
WARN_MINUTES = 120
G0_SECONDS = 60 * 60
LEASE_SECONDS = 3600
LEASE_RENEW_EVERY = 45 * 60
MIN_FREE_GIB = 4
SHARED_DOCS = ("docs/STATUS.md", "docs/STATUS_LOG.md", "docs/tasks/README.md", "docs/DECISIONS.md",
               "docs/DECISIONS_INDEX.md")
SECRET_PATTERNS = (re.compile(r"ibk_[A-Za-z0-9]{20,}"), re.compile(r"gh[pousr]_[A-Za-z0-9]{30,}"),
                   re.compile(r"sk-[A-Za-z0-9_-]{20,}"), re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"))
MODULES = ("gateway", "workspace", "state", "core", "runner", "git-adapter", "shell")
NODE_ROOTS = (".", "src/core", "src/gateway", "src/git-adapter", "src/runner", "src/shell",
              "src/shell/office-lite", "src/state", "src/workspace")

STOP_T3 = r"""
import json,os,pwd,subprocess
assert os.environ['HOME']=='/data/home' and pwd.getpwuid(os.getuid()).pw_name=='user'
def run(a):
 r=subprocess.run(a,capture_output=True,text=True,timeout=20)
 return {'exitCode':r.returncode,'value':r.stdout.strip()}
before=run(['systemctl','--user','is-active','t3code.service'])
stop=run(['systemctl','--user','stop','t3code.service'])
after=run(['systemctl','--user','is-active','t3code.service'])
p=subprocess.run(['pgrep','-x','cloudflared'],capture_output=True,text=True)
print(json.dumps({'wasInitiallyActive':before['value']=='active','stopExitCode':stop['exitCode'],'after':after['value'],'cloudflaredExists':p.returncode==0}))
"""
CREDENTIAL_META = r"""
import datetime,hashlib,json,os,stat
from pathlib import Path
out={}
for rel in ('.claude/.credentials.json','.codex/auth.json'):
 p=Path(os.environ['HOME'])/rel
 if not p.exists(): out[rel]=None; continue
 s=p.stat(); h=hashlib.sha256(p.read_bytes()).hexdigest()
 out[rel]={'sha256':h,'bytes':s.st_size,'permissions':oct(stat.S_IMODE(s.st_mode)),'mtimeNs':s.st_mtime_ns}
print(json.dumps(out))
"""
GENERATE_KEY = r"""
set -euo pipefail
umask 077
dir=/data/home/.wp-keys
mkdir -p "$dir"; chmod 700 "$dir"
[ -e "$dir/$1" ] || ssh-keygen -q -t ed25519 -N '' -C "wp-$1" -f "$dir/$1"
cat "$dir/$1.pub"
"""
REMOVE_KEY = r"""
set -euo pipefail
rm -f "/data/home/.wp-keys/$1" "/data/home/.wp-keys/$1.pub"
[ ! -e "/data/home/.wp-keys/$1" ]
"""
FETCH = r"""
set -euo pipefail
export GIT_SSH_COMMAND="ssh -i /data/home/.wp-keys/$1-read -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/data/home/.wp-keys/known_hosts"
dir="/data/home/wp/$1"
mkdir -p "$dir"
git clone --bare --quiet "$2" "$dir/staging.git"
git -C "$dir/staging.git" cat-file -e "$3^{commit}"
git -C "$dir/staging.git" worktree add --quiet -b "box/$1" "$dir/work" "$3"
git -C "$dir/work" config user.name "wp-$1"
git -C "$dir/work" config user.email "wp-$1@localhost.invalid"
"""
PREPARE = r"""
set -euo pipefail
bash "/data/home/wp/$1/work/scripts/instabox/prepare-linux.sh" "/data/home/wp/$1/work"
"""
G0 = r"""
set -euo pipefail
source /data/home/bin/env.sh
cd "/data/home/wp/$1/work"
shift
npm run test:local -- "$@"
"""
CODEX = r"""
exec codex exec -C "$1/work" --sandbox "$2" --json --ephemeral -o "$1/last.md" - < "$1/TASK.md"
"""
CLAUDE = r"""
dir="$1"
mode="$2"
auth="$3"
shift 3
if [ "$auth" != login ]; then
  [ -s "$auth" ] || { echo WP_CLAUDE_TOKEN_MISSING >&2; exit 97; }
  CLAUDE_CODE_OAUTH_TOKEN="$(cat "$auth")"
  export CLAUDE_CODE_OAUTH_TOKEN
  rm -f "$auth"
fi
cd "$dir/work"
exec claude -p --permission-mode "$mode" --permission-prompts none --no-session-persistence --verbose --output-format stream-json "$@" < "$dir/TASK.md"
"""
PUSH = r"""
set -euo pipefail
export GIT_SSH_COMMAND="ssh -i /data/home/.wp-keys/$1-write -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/data/home/.wp-keys/known_hosts"
git -C "/data/home/wp/$1/work" push --quiet "$2" "box/$1:refs/heads/box/$1"
"""
WORK_STATE = r"""
set -euo pipefail
cd "/data/home/wp/$1/work"
printf '{"head":"%s","dirty":%s,"commits":%s}\n' "$(git rev-parse HEAD)" "$([ -n "$(git status --porcelain)" ] && echo true || echo false)" "$(git rev-list --count "$2..HEAD")"
"""
INPUT_FINGERPRINT = r"""
set -euo pipefail
source /data/home/bin/env.sh
python3 -I "/data/home/wp/$1/work/scripts/instabox/fingerprint.py" "/data/home/wp/$1/work"
"""


class WpError(Exception):
    pass


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def bash(script, *args):
    return ["bash", "-c", script, "wp", *args]


def checked(response):
    if response.get("exitCode") != 0 or any(response.get(k) for k in ("timedOut", "truncated", "oomKilled")):
        raise WpError("REMOTE_COMMAND_FAILED")
    return response.get("stdout", "")


class Package:
    """Local evidence directory: numbered O_EXCL receipts plus one atomically replaced state file."""

    def __init__(self, root, task):
        if not TASK_ID.fullmatch(task):
            raise WpError("INVALID_TASK_ID")
        self.directory = Path(root) / task
        self.state = {}

    def create(self):
        try:
            self.directory.mkdir(mode=0o700, parents=True)
        except FileExistsError:
            raise WpError("TASK_EXISTS") from None

    def load(self):
        try:
            self.state = json.loads((self.directory / "state.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise WpError("TASK_UNKNOWN") from None
        return self.state

    def save(self):
        temporary = self.directory / "state.json.tmp"
        temporary.write_text(json.dumps(self.state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.chmod(temporary, 0o600)
        os.replace(temporary, self.directory / "state.json")

    def receipt(self, name, obj):
        number = len(list(self.directory.glob("[0-9][0-9][0-9][0-9]-*.json"))) + 1
        path = self.directory / ("%04d-%s.json" % (number, name))
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(dict(obj, at=now()), stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        return path

    def set(self, **fields):
        self.state.update(fields)
        self.save()


class GitHub:
    """Deploy keys and host keys through the Mac's own gh login. No token is read or stored here."""

    def __init__(self, repo=DEFAULT_REPO, run=subprocess.run):
        self.repo, self.run = repo, run

    def api(self, method, route, fields=()):
        argv = ["gh", "api", "-X", method, route]
        for flag, name, value in fields:
            argv += [flag, "%s=%s" % (name, value)]
        done = self.run(argv, capture_output=True, text=True, timeout=60)
        if done.returncode != 0:
            raise WpError("GITHUB_API_FAILED")
        return json.loads(done.stdout) if done.stdout.strip() else {}

    def host_keys(self):
        return ["github.com " + key for key in self.api("GET", "meta")["ssh_keys"]]

    def add_key(self, title, public_key, read_only):
        reply = self.api("POST", "repos/%s/keys" % self.repo,
                         [("-f", "title", title), ("-f", "key", public_key),
                          ("-F", "read_only", "true" if read_only else "false")])
        return reply["id"]

    def delete_key(self, key_id):
        self.api("DELETE", "repos/%s/keys/%d" % (self.repo, key_id))


class Wp:
    def __init__(self, client, github, package, repo_url, sleep=time.sleep, home=HOME, run_local=None,
                 repo_root=REPO, mac_remote=None, claude_token=None, claude_token_account=None):
        # repo_url is what the machine uses (SSH with a deploy key); mac_remote is what the Mac uses (its own remote).
        self.c, self.gh, self.pkg, self.repo_url = client, github, package, repo_url
        self.mac_remote = mac_remote or repo_url
        self.sleep, self.home, self.repo_root = sleep, home, Path(repo_root)
        self.run_local = run_local or self._run_local
        self.last_lease = float("-inf")
        # Long-lived `claude setup-token` value from the Mac Keychain; never written to receipts or state.
        self.claude_token, self.claude_token_account = claude_token, claude_token_account

    # ---- remote helpers ----
    @property
    def s(self):
        return self.pkg.state

    def paths(self):
        task = self.s["task"]
        base = "%s/wp/%s" % (self.home, task)
        return {"bin": self.home + "/bin", "wp": base, "work": base + "/work", "jobs": self.home + "/jobs"}

    def tool(self, verb, *args):
        return [self.home + "/bin/box-job.sh", verb, *args]

    def upload(self, remote_path, data, mode="0644"):
        route = "machines/%s/files?path=%s&mode=%s&parents=true" % (
            self.s["machineId"], urllib.parse.quote(remote_path, safe=""), mode)
        self.c.retry_safe(lambda: self.c.request("PUT", route, data, {"Content-Type": "application/octet-stream"}, timeout=60),
                          self.sleep)

    def read_json(self, argv, timeout=20):
        response, retries = self.c.read_exec(self.s["machineId"], argv, timeout, sleep=self.sleep)
        if retries:
            self.pkg.receipt("read-retries", {"argv0": argv[0], "retries": retries})
        return json.loads(checked(response))

    def change(self, argv, timeout):
        """One state-changing command. A lost receipt is never resent; callers reconcile by reading."""
        return checked(self.c.exec_once(self.s["machineId"], argv, timeout))

    def idempotent(self, argv, timeout):
        """A command that gives the same outcome when repeated (stop a service, create-if-absent, remove).

        A lost reply is therefore safe to ask again, with the same bounded backoff as a read.
        """
        response, retries = self.c.read_exec(self.s["machineId"], argv, timeout, sleep=self.sleep)
        if retries:
            self.pkg.receipt("idempotent-retries", {"argv0": argv[0], "retries": retries})
        return checked(response)

    def renew_lease(self, force=False):
        if force or time.monotonic() - self.last_lease > LEASE_RENEW_EVERY:
            self.c.lease(self.s["machineId"], "wp-" + self.s["task"], LEASE_SECONDS)
            self.last_lease = time.monotonic()

    # ---- jobs ----
    def start_job(self, job_id, timeout, workdir, argv):
        command = self.tool("start", "--job-id", job_id, "--timeout", str(timeout), "--workdir", workdir, "--", *argv)
        try:
            out = json.loads(self.change(command, 30))
        except CloudError as error:
            if str(error) != "TRANSPORT_OR_JSON_ERROR_RECONCILE_BEFORE_RETRY":
                raise
            if self.job_status(job_id)["state"] == "MISSING":
                raise WpError("JOB_START_UNKNOWN") from None
            out = {"started": True, "reconciled": True}
        self.pkg.receipt("job-started-" + job_id, {"jobId": job_id, "timeout": timeout, "argv0": argv[0], **out})

    def job_status(self, job_id):
        return self.read_json(self.tool("status", "--job-id", job_id), 15)

    def wait_job(self, job_id, limit_seconds, interval=10):
        deadline = time.monotonic() + limit_seconds
        while True:
            status = self.job_status(job_id)
            if status["state"] != "RUNNING":
                return status
            if time.monotonic() > deadline:
                raise WpError("JOB_WAIT_LIMIT")
            self.renew_lease()
            self.sleep(interval)

    def collect(self, job_id, name, destination, status):
        """Download one job file in chunks; the whole-file SHA-256 must match result.json."""
        data, offset = b"", 0
        while True:
            chunk = self.read_json(self.tool("collect", "--job-id", job_id, "--file", name,
                                             "--offset", str(offset)), 30)
            piece = base64.b64decode(chunk["dataBase64"])
            if digest(piece) != chunk["chunkSha256"]:
                raise WpError("CHUNK_DIGEST_MISMATCH")
            data += piece
            offset += len(piece)
            if offset >= chunk["size"]:
                break
            if not piece:
                raise WpError("COLLECT_STALLED")
        if digest(data) != chunk["sha256"]:
            raise WpError("FILE_DIGEST_MISMATCH")
        expected = status.get("result", {}).get(name.split(".")[0])
        if expected and expected.get("sha256") not in (None, chunk["sha256"]):
            raise WpError("RESULT_DIGEST_MISMATCH")
        Path(destination).write_bytes(data)
        return {"name": name, "bytes": len(data), "sha256": chunk["sha256"]}

    def collect_job(self, job_id, status):
        folder = self.pkg.directory / "collected" / job_id
        folder.mkdir(parents=True, exist_ok=True)
        files = [self.collect(job_id, name, folder / name, status) for name in ("stdout.log", "stderr.log")]
        (folder / "result.json").write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
        return files

    # ---- open ----
    def open(self, task, base, snapshot_id, allowed_paths):
        if not COMMIT.fullmatch(base):
            raise WpError("INVALID_BASE_COMMIT")
        name = "wp-" + task
        machines = self.c.read("machines?limit=100", sleep=self.sleep)
        limit = self.c.read("usage", sleep=self.sleep)["limits"]["maxMachines"]
        if machines.get("nextCursor") or len(machines["machines"]) >= limit:
            raise WpError("NO_MACHINE_SLOT")
        if any(m["name"] == name for m in machines["machines"]):
            raise WpError("MACHINE_NAME_IN_USE")
        snapshot = self.c.read("snapshots/" + snapshot_id, sleep=self.sleep)
        if snapshot.get("status") != "ready" or snapshot.get("orgId") != self.c.account["expectedOrgId"]:
            raise WpError("SNAPSHOT_NOT_READY")
        refs = self.gh_refs()
        self.pkg.create()
        self.pkg.state = {"task": task, "account": self.c.account["alias"], "base": base, "snapshotId": snapshot_id,
                          "machineName": name, "allowedPaths": sorted(allowed_paths), "refsBefore": refs,
                          "state": "OPENING", "createdAt": now(), "keys": {}}
        self.pkg.save()
        key = str(uuid.uuid4())
        self.pkg.receipt("create-plan", {"name": name, "snapshotId": snapshot_id, "idempotencyKey": key})
        try:
            operation = self.c.create_from_snapshot(name, snapshot_id, key)
        except CloudError as error:
            if str(error) != "TRANSPORT_OR_JSON_ERROR_RECONCILE_BEFORE_RETRY":
                raise
            found = [m for m in self.c.read("machines?limit=100", sleep=self.sleep)["machines"] if m["name"] == name]
            if len(found) != 1:
                raise WpError("CREATE_UNKNOWN") from None
            operation = {"machineId": found[0]["id"], "id": None, "state": "succeeded"}
        self.pkg.set(machineId=operation["machineId"])
        if operation.get("id"):
            operation = self.c.wait(operation, 120)
        if operation.get("state") != "succeeded":
            raise WpError("CREATE_FAILED")
        self.wait_ready()
        self.renew_lease(force=True)
        try:
            self.stop_t3()
            self.check_disk()
        except WpError as error:
            self.abort_if_safe(str(error))
            raise
        baseline = self.read_json(["python3", "-c", CREDENTIAL_META], 25)
        self.pkg.receipt("credentials-baseline", {"files": baseline})
        self.pkg.set(credentialsBaseline=baseline)
        for name_ in ("box-job.sh", "box_job.py", "env.sh"):
            self.upload(self.paths()["bin"] + "/" + name_, (TOOLS / name_).read_bytes(),
                        "0755" if name_ != "env.sh" else "0644")
        self.upload(self.home + "/.wp-keys/known_hosts", ("\n".join(self.gh.host_keys()) + "\n").encode(), "0644")
        self.pkg.set(openStep="uploaded")
        return self.finish_open()

    def resume_open(self):
        """Continue an open that stopped after the machine was prepared; the machine is checked, never recreated."""
        if self.s.get("state") != "OPENING" or self.s.get("openStep") != "uploaded":
            raise WpError("NOTHING_TO_RESUME")
        self.wait_ready()
        return self.finish_open()

    def finish_open(self):
        task = self.s["task"]
        try:
            self.fetch_checkout()
            self.run_open_job("prep", 1800, bash(PREPARE, task))
        except WpError as error:
            self.abort_if_safe(str(error))
            raise
        fingerprint_out = self.job_output("prep-fp", bash(INPUT_FINGERPRINT, task))
        self.pkg.set(workerFingerprint=fingerprint_out["inputs"]["sha256"], state="OPENED")
        return self.s

    def gh_refs(self):
        done = self.run_local(["git", "ls-remote", self.mac_remote], self.repo_root, 60)
        if done.returncode != 0:
            raise WpError("STAGING_REFS_UNREADABLE")
        return {line.split("\t")[1]: line.split("\t")[0] for line in done.stdout.splitlines() if "\t" in line}

    def wait_ready(self):
        end = time.monotonic() + 120
        while True:
            machine = self.c.machine(self.s["machineId"])
            if machine.get("name") != self.s["machineName"]:
                raise WpError("MACHINE_IDENTITY_MISMATCH")
            if machine.get("runtime", {}).get("ready"):
                return
            if time.monotonic() > end:
                raise WpError("MACHINE_NOT_READY")
            self.sleep(2)

    def stop_t3(self):
        out = json.loads(self.idempotent(["python3", "-c", STOP_T3], 55))
        self.pkg.receipt("t3-stopped", out)
        if out["stopExitCode"] != 0 or out["after"] != "inactive" or out["cloudflaredExists"]:
            raise WpError("T3_NOT_STOPPED")

    def check_disk(self):
        data = [f for f in self.c.disk(self.s["machineId"])["filesystems"] if f.get("mount") == "/data"]
        if not data:
            raise WpError("DISK_UNKNOWN")
        free = data[0].get("availableBytes")
        if free is None or free < MIN_FREE_GIB * 1024 ** 3:
            raise WpError("DISK_TOO_SMALL")

    def with_key(self, kind, action):
        """Create a one-time deploy key on the machine, register it, run action, then always revoke and remove it."""
        if kind == "write" and self.s.get("mode") == "review":
            raise WpError("REVIEW_WRITE_KEY_FORBIDDEN")
        task = self.s["task"]
        label = "%s-%s" % (task, kind)
        public = self.idempotent(bash(GENERATE_KEY, label), 30).strip()
        self.pkg.receipt("key-plan-" + kind, {"title": "wp-" + label, "readOnly": kind == "read"})
        try:
            key_id = self.gh.add_key("wp-" + label, public, kind == "read")
        except WpError:
            self.idempotent(bash(REMOVE_KEY, label), 30)
            raise
        self.s["keys"][kind] = {"id": key_id, "registeredAt": now(), "revokedAt": None}
        self.pkg.save()
        try:
            return action()
        finally:
            self.revoke_key(kind, label)

    def revoke_key(self, kind, label):
        entry = self.s["keys"][kind]
        if entry["revokedAt"] is None:
            self.gh.delete_key(entry["id"])
            entry["revokedAt"] = now()
            self.pkg.save()
        self.idempotent(bash(REMOVE_KEY, label), 30)

    def run_open_job(self, name, timeout, argv, workdir=None):
        job_id = "%s-%s" % (name, self.s["task"])
        self.start_job(job_id, timeout, workdir or self.home, argv)
        status = self.wait_job(job_id, timeout + 60)
        files = self.collect_job(job_id, status)
        if status["state"] != "FINISHED" or status["result"].get("exitCode") != 0:
            raise WpError("OPEN_JOB_FAILED_" + name.upper())
        self.pkg.receipt("job-done-" + name, {"files": files, "durationSeconds": status["result"]["durationSeconds"]})
        return status

    def job_output(self, name, argv):
        job_id = "%s-%s" % (name, self.s["task"])
        self.start_job(job_id, 300, self.home, argv)
        status = self.wait_job(job_id, 360)
        files = self.collect_job(job_id, status)
        if status["state"] != "FINISHED" or status["result"].get("exitCode") != 0:
            raise WpError("OPEN_JOB_FAILED_" + name.upper())
        return json.loads((self.pkg.directory / "collected" / job_id / "stdout.log").read_text(encoding="utf-8"))

    def fetch_checkout(self):
        task = self.s["task"]
        self.with_key("read", lambda: self.run_open_job("fetch", 900, bash(FETCH, task, self.repo_url, self.s["base"])))

    def abort_if_safe(self, reason):
        """Delete only when the failure was fully observed and its logs are collected; otherwise keep the machine."""
        if reason.startswith(("T3_NOT_STOPPED", "DISK_", "OPEN_JOB_FAILED_")):
            self.abort(reason)
        else:
            self.pkg.set(state="OPEN_FAILED_MACHINE_KEPT", abortReason=reason)

    def abort(self, reason):
        """Open failed before any employee work: keep the logs, then delete the machine."""
        self.pkg.set(state="ABORTED", abortReason=reason)
        try:
            self.c.delete_machine(self.s["machineId"], self.s["machineName"], str(uuid.uuid4()))
            self.pkg.set(machineDeleted=True)
        except CloudError as error:
            self.pkg.set(machineDeleted=False, deleteError=str(error)[:80])

    # ---- run / poll ----
    def run(self, agent, task_file, allowed_tools=(), modules=(), mode="execute", timeout=EMPLOYEE_SECONDS):
        if self.s.get("state") != "OPENED":
            raise WpError("EMPLOYEE_ALREADY_STARTED_OR_PACKAGE_NOT_OPEN")
        if mode not in ("execute", "review") or not 1 <= timeout <= EMPLOYEE_SECONDS:
            raise WpError("INVALID_EMPLOYEE_MODE_OR_TIMEOUT")
        if any(module not in MODULES for module in modules):
            raise WpError("INVALID_MODULE")
        task = self.s["task"]
        sheet = Path(task_file).read_bytes()
        paths = self.paths()
        if agent == "codex":
            argv = bash(CODEX, paths["wp"], "read-only" if mode == "review" else "workspace-write")
        elif agent == "claude":
            extra = ["--allowedTools", ",".join(allowed_tools)] if allowed_tools else []
            if mode == "review":
                extra += ["--disallowedTools", "Edit,Write,NotebookEdit"]
            auth = self.token_path() if self.claude_token else "login"
            argv = bash(CLAUDE, paths["wp"], "plan" if mode == "review" else "acceptEdits", auth, *extra)
        else:
            raise WpError("UNKNOWN_AGENT")
        claude_auth = None
        if agent == "claude":
            claude_auth = "CLAUDE_CODE_OAUTH_TOKEN" if self.claude_token else "SNAPSHOT_LOGIN"
        self.upload(paths["wp"] + "/TASK.md", sheet)
        if claude_auth == "CLAUDE_CODE_OAUTH_TOKEN":
            self.upload(self.token_path(), self.claude_token, "0600")
        self.pkg.receipt("employee-plan", {"agent": agent, "mode": mode, "timeout": timeout,
                                           "taskSheetSha256": digest(sheet), "claudeAuth": claude_auth,
                                           "claudeTokenAccount": self.claude_token_account if claude_auth else None})
        self.pkg.set(agent=agent, mode=mode, employeeTimeoutSeconds=timeout, taskSheetSha256=digest(sheet),
                     modules=list(modules), state="RUNNING", employeeStartedAt=now(), claudeAuth=claude_auth,
                     claudeTokenAccount=self.claude_token_account if claude_auth else None)
        self.start_job("emp-" + task, timeout, paths["work"], argv)
        self.renew_lease(force=True)
        return self.s

    def token_path(self):
        return self.home + "/.wp-secrets/claude-oauth-token"

    def check_token_absent(self):
        """The existing secret scan covers only the commit diff; this covers every local file of the package."""
        if self.s.get("claudeAuth") != "CLAUDE_CODE_OAUTH_TOKEN":
            return
        if not self.claude_token:
            raise WpError("CLAUDE_TOKEN_UNAVAILABLE_FOR_LEAK_CHECK")
        hits = sorted(str(p.relative_to(self.pkg.directory)) for p in self.pkg.directory.rglob("*")
                      if p.is_file() and self.claude_token in p.read_bytes())
        self.pkg.set(claudeTokenInPackageFiles=bool(hits))
        if hits:
            self.pkg.set(state="FAILED", failure="CLAUDE_TOKEN_IN_PACKAGE_FILES", tokenHits=hits[:20])
            raise WpError("CLAUDE_TOKEN_IN_PACKAGE_FILES_MACHINE_KEPT")

    def poll(self):
        task = self.s["task"]
        status = self.job_status("emp-" + task)
        report = {"state": self.s["state"], "employee": status["state"]}
        if status["state"] == "RUNNING":
            self.renew_lease()
            minutes = (datetime.datetime.now(datetime.timezone.utc)
                       - datetime.datetime.fromisoformat(self.s["employeeStartedAt"])).total_seconds() / 60
            report["elapsedMinutes"] = round(minutes, 1)
            report["warning"] = "OVER_%d_MINUTES" % WARN_MINUTES if minutes >= WARN_MINUTES else None
        elif status["state"] == "FINISHED":
            report["result"] = {k: status["result"].get(k) for k in ("exitCode", "signal", "timedOut", "durationSeconds")}
        report["disk"] = self.c.disk(self.s["machineId"]).get("warning")
        return report

    def commit(self, manifest_file):
        """Commit inspected employee output using a Mac-supplied exact manifest, without a write key."""
        if self.s.get("mode") != "execute" or self.s.get("state") != "RUNNING":
            raise WpError("COMMIT_REQUIRES_EXECUTION_PACKAGE")
        if self.s.get("commitStartedAt"):
            raise WpError("COMMIT_ALREADY_STARTED_RECONCILE_ORIGINAL_JOB")
        employee = self.job_status("emp-" + self.s["task"])
        result = employee.get("result", {})
        if (employee["state"] != "FINISHED" or result.get("exitCode") != 0
                or result.get("timedOut") or result.get("signal") is not None):
            raise WpError("EMPLOYEE_NOT_SUCCESSFULLY_FINISHED")
        self.collect_job("emp-" + self.s["task"], employee)
        after = self.read_json(["python3", "-c", CREDENTIAL_META], 25)
        if after != self.s["credentialsBaseline"]:
            self.pkg.set(state="CREDENTIALS_HOLD", credentialsChanged=True, credentialsHoldBeforeCommit=True)
            raise WpError("CREDENTIALS_HOLD_BEFORE_COMMIT")
        data = Path(manifest_file).read_bytes()
        spec = json.loads(data)
        if spec.get("base") != self.s["base"] or spec.get("branch") != "box/" + self.s["task"]:
            raise WpError("COMMIT_MANIFEST_IDENTITY_MISMATCH")
        names = [entry["path"] for entry in spec["files"]]
        allowed = tuple(self.s["allowedPaths"])
        if not allowed or any(not name.startswith(allowed) or name in SHARED_DOCS for name in names):
            raise WpError("COMMIT_MANIFEST_OUT_OF_SCOPE")
        paths = self.paths()
        helper = (TOOLS / "commit_files.py").read_bytes()
        self.upload(paths["wp"] + "/commit_files.py", helper)
        self.upload(paths["wp"] + "/commit-manifest.json", data)
        self.pkg.receipt("commit-plan", {"manifestSha256": digest(data), "helperSha256": digest(helper),
                                         "files": spec["files"]})
        self.pkg.set(commitStartedAt=now(), commitManifestSha256=digest(data))
        receipt = self.job_output("commit", ["python3", "-I", paths["wp"] + "/commit_files.py",
                                            paths["work"], paths["wp"] + "/commit-manifest.json"])
        work = self.read_json(bash(WORK_STATE, self.s["task"], self.s["base"]), 20)
        if (receipt.get("status") != "COMMITTED" or receipt.get("manifestSha256") != digest(data)
                or work != {"head": receipt.get("commit"), "dirty": False, "commits": 1}):
            raise WpError("COMMIT_RESULT_MISMATCH_MACHINE_KEPT")
        self.pkg.receipt("commit-done", receipt)
        self.pkg.set(wrapperCommit=receipt["commit"])
        return receipt

    # ---- close ----
    def close(self, discard_credentials=False):
        task = self.s["task"]
        if self.s.get("machineDeleted"):
            raise WpError("ALREADY_CLOSED")
        if self.s["state"] == "CREDENTIALS_HOLD":
            if self.s.get("credentialsHoldBeforeCommit"):
                raise WpError("UNCOMMITTED_CREDENTIALS_HOLD_MACHINE_KEPT")
            # Evidence is collected; only the owner's decision on the login is open.
            if not discard_credentials:
                return {"state": "CREDENTIALS_HOLD", "machineKept": True}
            if self.s.get("mode") == "review" and self.s.get("work") != {"head": self.s["base"], "dirty": False, "commits": 0}:
                raise WpError("REVIEW_WORKSPACE_CHANGED_MACHINE_KEPT")
            return self.delete_machine_after_close(self.s["resumeState"])
        employee = self.job_status("emp-" + task)
        if employee["state"] != "FINISHED":
            raise WpError("EMPLOYEE_NOT_FINISHED")
        if self.s.get("mode") == "review":
            return self.close_review(employee, discard_credentials)
        self.pkg.set(state="FINISHING")
        work = self.read_json(bash(WORK_STATE, task, self.s["base"]), 20)
        self.pkg.receipt("work-state", work)
        for m in self.s.get("modules", []):
            if m not in MODULES:
                raise WpError("INVALID_MODULE")
        g0_args = [a for m in self.s.get("modules", []) for a in ("--module", m)]
        self.start_job("g0-" + task, G0_SECONDS, self.paths()["work"], bash(G0, task, *g0_args))
        g0 = self.wait_job("g0-" + task, G0_SECONDS + 60)
        problems = []
        collected = {}
        for job_id, status in (("emp-" + task, employee), ("g0-" + task, g0)):
            try:
                collected[job_id] = self.collect_job(job_id, status)
            except (WpError, CloudError) as error:
                problems.append("%s:%s" % (job_id, error))
        if problems:
            self.pkg.set(state="COLLECT_FAILED", problems=problems)
            self.pkg.receipt("collect-failed", {"problems": problems})
            raise WpError("COLLECT_FAILED_MACHINE_KEPT")
        self.check_token_absent()
        g0_summary = self.parse_g0(g0)
        after = self.read_json(["python3", "-c", CREDENTIAL_META], 25)
        changed = after != self.s["credentialsBaseline"]
        self.pkg.receipt("close-evidence", {"g0": g0_summary, "credentialsChanged": changed, "work": work,
                                            "collected": collected})
        self.pkg.set(g0=g0_summary, credentialsChanged=changed, work=work)
        if work["dirty"]:
            # The work exists only on the machine, so it stays until the owner decides.
            self.pkg.set(state="FAILED", failure="UNCOMMITTED_CHANGES")
            raise WpError("UNCOMMITTED_CHANGES_MACHINE_KEPT")
        pushed = None
        if work["commits"] >= 1:
            pushed = self.with_key("write", lambda: self.push())
        final = "PUSHED" if pushed and g0_summary["result"] == "PASS" else "FAILED"
        self.pkg.set(pushedCommit=pushed, state=final, failure=None if pushed else "NO_COMMITS")
        if changed and not discard_credentials:
            self.pkg.set(state="CREDENTIALS_HOLD", resumeState=final)
            return {"state": "CREDENTIALS_HOLD", "machineKept": True}
        return self.delete_machine_after_close(final)

    def close_review(self, employee, discard_credentials=False):
        """Collect the report and prove no repository changes; never run G0 or request a write key."""
        self.pkg.set(state="FINISHING")
        try:
            collected = self.collect_job("emp-" + self.s["task"], employee)
        except (WpError, CloudError) as error:
            self.pkg.set(state="COLLECT_FAILED", problems=[str(error)])
            raise WpError("COLLECT_FAILED_MACHINE_KEPT") from None
        self.check_token_absent()
        work = self.read_json(bash(WORK_STATE, self.s["task"], self.s["base"]), 20)
        after = self.read_json(["python3", "-c", CREDENTIAL_META], 25)
        changed = after != self.s["credentialsBaseline"]
        result = employee["result"]
        completed = (result.get("exitCode") == 0 and not result.get("timedOut")
                     and result.get("signal") is None and result.get("tmpdirRemoved") is True)
        clean = work == {"head": self.s["base"], "dirty": False, "commits": 0}
        final = "CLOSED" if completed and clean else "FAILED"
        self.pkg.receipt("review-evidence", {"base": self.s["base"], "work": work, "collected": collected,
                                             "cliCompleted": completed, "credentialsChanged": changed,
                                             "contentVerdict": "NOT_VERIFIED"})
        self.pkg.set(work=work, credentialsChanged=changed, g0={"result": "N/A"}, reviewCliCompleted=completed,
                     state=final, failure=None if completed and clean else "REVIEW_FAILED_OR_WORKSPACE_CHANGED")
        if changed and not discard_credentials:
            self.pkg.set(state="CREDENTIALS_HOLD", resumeState=final)
            return {"state": "CREDENTIALS_HOLD", "machineKept": True}
        if not clean:
            raise WpError("REVIEW_WORKSPACE_CHANGED_MACHINE_KEPT")
        return self.delete_machine_after_close(final)

    def delete_machine_after_close(self, final):
        self.c.delete_machine(self.s["machineId"], self.s["machineName"], str(uuid.uuid4()))
        gone = all(m["id"] != self.s["machineId"] for m in self.c.read("machines?limit=100", sleep=self.sleep)["machines"])
        self.pkg.set(machineDeleted=gone)
        if not gone:
            raise WpError("DELETE_NOT_CONFIRMED")
        return {"state": final, "machineKept": False, "commit": self.s.get("pushedCommit"),
                "g0": self.s["g0"]["result"]}

    def parse_g0(self, status):
        tail = self.read_json(self.tool("collect", "--job-id", "g0-" + self.s["task"], "--file", "stdout.log",
                                        "--tail", str(256 * 1024), "--limit", str(256 * 1024)), 30)
        text = base64.b64decode(tail["dataBase64"]).decode("utf-8", errors="replace")
        lines = [line for line in text.splitlines() if line.startswith("[verify-timing] ")]
        omitted = [line for line in text.splitlines() if "NOT_PERFORMED" in line]
        timings = json.loads(lines[-1][len("[verify-timing] "):]) if lines else None
        exit_code = status.get("result", {}).get("exitCode")
        if timings is None or exit_code is None:
            result = "UNKNOWN"
        else:
            result = "PASS" if exit_code == 0 and all(t["status"] == 0 for t in timings["timings"]) else "FAIL"
        return {"result": result, "exitCode": exit_code, "omitted": omitted, "timings": timings}

    def push(self):
        if self.s.get("mode") == "review":
            raise WpError("REVIEW_PUSH_FORBIDDEN")
        task = self.s["task"]
        self.start_job("push-" + task, 300, self.home, bash(PUSH, task, self.repo_url))
        status = self.wait_job("push-" + task, 360)
        self.collect_job("push-" + task, status)
        if status["state"] != "FINISHED" or status["result"].get("exitCode") != 0:
            raise WpError("PUSH_FAILED")
        out = self.run_local(["git", "ls-remote", self.mac_remote, "refs/heads/box/" + task], self.repo_root, 60)
        sha = out.stdout.split("\t")[0] if out.returncode == 0 and out.stdout else ""
        if not COMMIT.fullmatch(sha) or sha != self.s["work"]["head"]:
            raise WpError("PUSHED_REF_MISMATCH")
        return sha

    # ---- receive (G1) ----
    def _run_local(self, argv, cwd, timeout):
        return subprocess.run(argv, cwd=str(cwd), capture_output=True, text=True, timeout=timeout)

    def git(self, *args, timeout=120, cwd=None):
        done = self.run_local(["git", *args], cwd or self.repo_root, timeout)
        if done.returncode != 0:
            raise WpError("GIT_FAILED_" + args[0].upper().replace("-", "_"))
        return done.stdout

    def receive(self):
        task, base = self.s["task"], self.s["base"]
        checks = {}
        local_ref = "refs/wp/" + task
        self.git("fetch", "--quiet", self.mac_remote, "+refs/heads/box/%s:%s" % (task, local_ref))
        tip = self.git("rev-parse", local_ref).strip()
        checks["tipMatchesPush"] = self.verdict(tip == self.s.get("pushedCommit"))
        chain = self.git("rev-list", "--first-parent", "--reverse", "%s..%s" % (base, tip)).split()
        parents = self.git("rev-list", "--parents", "-n", "1", chain[0]).split()[1:] if chain else []
        checks["parentChainStartsAtBase"] = self.verdict(bool(chain) and base in parents)
        refs_now = self.gh_refs()
        added = {k for k in refs_now if k not in self.s["refsBefore"]}
        changed = {k for k in self.s["refsBefore"] if refs_now.get(k) != self.s["refsBefore"][k]}
        checks["stagingRefsOnlyBranchAdded"] = self.verdict(added == {"refs/heads/box/" + task} and not changed)
        names = [line.split("\t")[-1] for line in
                 self.git("diff", "--no-renames", "--name-status", base, tip).splitlines() if line]
        allowed = tuple(self.s["allowedPaths"])
        outside = [n for n in names if not n.startswith(allowed)] if allowed else names
        shared = [n for n in names if n in SHARED_DOCS]
        checks["changedPathsInScope"] = self.verdict(not outside and not shared, {"outside": outside[:20], "shared": shared})
        added_lines = [line for line in self.git("diff", "--no-renames", "-U0", base, tip).splitlines()
                       if line.startswith("+") and not line.startswith("+++")]
        leaks = sum(1 for line in added_lines if any(p.search(line) for p in SECRET_PATTERNS))
        checks["secretScan"] = self.verdict(leaks == 0, {"matchingLines": leaks})
        if all(v["result"] == "PASS" for v in checks.values()):
            checks.update(self.checks_in_worktree(tip, names))
        else:
            for name in ("fingerprintMatches", "docsCheck", "moduleTests"):
                checks[name] = {"result": "NOT_PERFORMED", "reason": "earlier check failed"}
        overall = "PASS" if all(v["result"] == "PASS" for v in checks.values()) else "FAIL"
        receipt = {"task": task, "base": base, "tip": tip, "overall": overall, "checks": checks,
                   "g0": self.s.get("g0", {}).get("result"), "credentialsChanged": self.s.get("credentialsChanged")}
        self.pkg.receipt("mac-receipt", receipt)
        ledger = self.pkg.directory.parent / "ledger.jsonl"
        with ledger.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"task": task, "account": self.s["account"], "machine": self.s["machineName"],
                                     "snapshot": self.s["snapshotId"], "base": base, "tip": tip,
                                     "g0": receipt["g0"], "g1": overall, "keys": self.s["keys"],
                                     "credentialsChanged": receipt["credentialsChanged"], "at": now()}) + "\n")
        self.pkg.set(state="CLOSED" if overall == "PASS" else "G1_FAILED")
        return receipt

    @staticmethod
    def verdict(passed, detail=None):
        return dict({"result": "PASS" if passed else "FAIL"}, **(detail or {}))

    def checks_in_worktree(self, tip, names):
        modules = sorted(({n.split("/")[1] for n in names if n.startswith("src/") and n.count("/") >= 2}
                          | set(self.s.get("modules", []))) & set(MODULES))
        out = {}
        tree = Path(tempfile.mkdtemp(prefix="win7-eng06-g1-"))
        added = False
        try:
            self.git("worktree", "add", "--quiet", "--detach", str(tree / "tree"), tip)
            added = True
            root = tree / "tree"
            for node_root in NODE_ROOTS:
                source = self.repo_root / node_root / "node_modules"
                if source.is_dir() and (root / node_root).is_dir():
                    os.symlink(source, root / node_root / "node_modules")
            mine = fingerprint.input_fingerprint(root)["sha256"]
            out["fingerprintMatches"] = self.verdict(mine == self.s.get("workerFingerprint"),
                                                     {"mac": mine[:8] + "…", "worker": str(self.s.get("workerFingerprint"))[:8] + "…"})
            docs = self.run_local(["npm", "run", "docs:check"], root, 300)
            out["docsCheck"] = self.verdict(docs.returncode == 0)
            ran = []
            for module in modules:
                done = self.run_local(["node", "scripts/verify_integration.mjs", "--daily", "--module", module], root, 1800)
                ran.append({"module": module, "exitCode": done.returncode})
            out["moduleTests"] = self.verdict(all(r["exitCode"] == 0 for r in ran), {"modules": ran})
        finally:
            if added:
                self.run_local(["git", "worktree", "remove", "--force", str(tree / "tree")], self.repo_root, 120)
            shutil.rmtree(tree, ignore_errors=True)
        return out


def read_claude_token(alias):
    import accounts
    try:
        token = accounts.Keychain(accounts.CLAUDE_SERVICE).read(alias)
    except accounts.SetupError as error:
        raise WpError(str(error)) from None
    if token is None or not accounts.CLAUDE_TOKEN.fullmatch(token):
        raise WpError("CLAUDE_TOKEN_MISSING_OR_INVALID")
    return token


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account", required=True)
    parser.add_argument("--task", required=True)
    parser.add_argument("--outputs", type=Path, default=REPO / "outputs" / "wp")
    parser.add_argument("--repo", default=DEFAULT_REPO)
    parser.add_argument("--repo-url")
    parser.add_argument("--mac-remote", default="staging")
    sub = parser.add_subparsers(dest="action", required=True)
    opener = sub.add_parser("open")
    opener.add_argument("--base", required=True)
    opener.add_argument("--snapshot", required=True)
    opener.add_argument("--allow", action="append", default=[])
    runner = sub.add_parser("run")
    runner.add_argument("--agent", choices=("codex", "claude"), required=True)
    runner.add_argument("--task-file", type=Path, required=True)
    runner.add_argument("--allowed-tools", default="")
    runner.add_argument("--module", action="append", default=[])
    runner.add_argument("--mode", choices=("execute", "review"), default="execute")
    runner.add_argument("--timeout", type=int, default=EMPLOYEE_SECONDS)
    runner.add_argument("--claude-token-account", help="Keychain account holding a `claude setup-token` value")
    sub.add_parser("poll")
    committer = sub.add_parser("commit")
    committer.add_argument("--manifest", type=Path, required=True)
    closer = sub.add_parser("close")
    closer.add_argument("--discard-credentials", action="store_true")
    sub.add_parser("receive")
    args = parser.parse_args()
    url = args.repo_url or "git@github.com:%s.git" % args.repo
    try:
        package = Package(args.outputs, args.task)
        if args.action != "open":
            package.load()
        alias = getattr(args, "claude_token_account", None) or package.state.get("claudeTokenAccount")
        token = read_claude_token(alias) if alias else None
        wp = Wp(Client(args.account), GitHub(args.repo), package, url, mac_remote=args.mac_remote,
                claude_token=token, claude_token_account=alias)
        if args.action == "open":
            out = wp.open(args.task, args.base, args.snapshot, args.allow)
        elif args.action == "run":
            tools = [t for t in args.allowed_tools.split(",") if t]
            out = wp.run(args.agent, args.task_file, tools, args.module, args.mode, args.timeout)
        elif args.action == "poll":
            out = wp.poll()
        elif args.action == "commit":
            out = wp.commit(args.manifest)
        elif args.action == "close":
            out = wp.close(args.discard_credentials)
        else:
            out = wp.receive()
    except (WpError, CloudError) as error:
        print(json.dumps({"error": str(error)[:200]}))
        raise SystemExit(1)
    print(json.dumps(out, ensure_ascii=False))
    if isinstance(out, dict) and out.get("state") == "CREDENTIALS_HOLD":
        raise SystemExit(3)


if __name__ == "__main__":
    main()

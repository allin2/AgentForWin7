#!/usr/bin/env python3
"""Background jobs on a work-package machine (design r4 section 4.1). Standard library only.

start    create the job directory and a detached supervisor, then return at once
status   read-only: spec, result.json and whether the supervisor is alive
collect  read-only: one base64 chunk of a job file plus the SHA-256 of the whole file

The supervisor runs the command in its own process group with a per-job TMPDIR. On every exit path
it removes that TMPDIR, then writes result.json through a temporary file and an atomic rename.
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
import signal
import subprocess
import sys
import time

JOB_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,39}\Z")
FILE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")
MAX_TIMEOUT_SECONDS = 4 * 3600
CHUNK_MAX = 700 * 1024  # base64 of this stays under the 1 MiB exec stdout limit
TMP_PREFIX = "win7-job-"


class JobError(Exception):
    pass


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def roots(args):
    jobs = Path(args.jobs_root or os.environ.get("BOX_JOBS_ROOT") or Path.home() / "jobs")
    tmp = Path(args.tmp_root or os.environ.get("BOX_TMP_ROOT") or Path.home() / "tmp")
    return jobs, tmp


def job_directory(jobs_root, job_id):
    if not JOB_ID.fullmatch(job_id):
        raise JobError("INVALID_JOB_ID")
    return jobs_root / job_id


def write_atomic(path, text):
    temporary = path.with_name(path.name + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        stream.write(text)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def file_digest(path):
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(65536), b""):
            digest.update(block)
            size += len(block)
    return {"bytes": size, "sha256": digest.hexdigest()}


def command_start(args):
    jobs_root, tmp_root = roots(args)
    job_dir = job_directory(jobs_root, args.job_id)
    argv = list(args.argv)
    if argv and argv[0] == "--":
        argv = argv[1:]
    if not argv:
        raise JobError("EMPTY_COMMAND")
    if not 1 <= args.timeout <= MAX_TIMEOUT_SECONDS:
        raise JobError("INVALID_TIMEOUT")
    workdir = Path(args.workdir)
    if not workdir.is_dir():
        raise JobError("WORKDIR_MISSING")
    jobs_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        job_dir.mkdir(mode=0o700)
    except FileExistsError:
        raise JobError("JOB_EXISTS") from None
    spec = {"jobId": args.job_id, "argv": argv, "workdir": str(workdir.resolve()),
            "timeoutSeconds": args.timeout, "tmpdir": str(tmp_root / (TMP_PREFIX + args.job_id)),
            "createdAt": now()}
    spec["specSha256"] = hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()
    write_atomic(job_dir / "spec.json", json.dumps(spec, indent=2) + "\n")
    with (job_dir / "supervisor.log").open("wb") as log:
        process = subprocess.Popen(
            [sys.executable, "-I", os.path.abspath(__file__), "_supervise", "--job-id", args.job_id,
             "--jobs-root", str(jobs_root), "--tmp-root", str(tmp_root)],
            stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, close_fds=True)
    # Record the pid before returning, so an immediate status call cannot see a job without a supervisor.
    write_atomic(job_dir / "supervisor.pid", str(process.pid) + "\n")
    print(json.dumps({"jobId": args.job_id, "started": True, "supervisorPid": process.pid}))


def tool_versions():
    versions = {}
    for tool in ("node", "claude", "codex"):
        path = shutil.which(tool)
        if not path:
            versions[tool] = "absent"
            continue
        try:
            done = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=10)
            versions[tool] = (done.stdout.strip().splitlines() or ["unknown"])[0][:100]
        except (OSError, subprocess.SubprocessError):
            versions[tool] = "unavailable"
    return versions


def stop_group(process, grace_seconds=20):
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=grace_seconds)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def command_supervise(args):
    jobs_root, tmp_root = roots(args)
    job_dir = job_directory(jobs_root, args.job_id)
    spec = json.loads((job_dir / "spec.json").read_text(encoding="utf-8"))
    write_atomic(job_dir / "supervisor.pid", str(os.getpid()) + "\n")
    tmpdir = Path(spec["tmpdir"])
    if tmpdir.parent != tmp_root or not tmpdir.name.startswith(TMP_PREFIX):
        raise JobError("TMPDIR_OUTSIDE_ROOT")
    result = {"jobId": spec["jobId"], "specSha256": spec["specSha256"], "startedAt": now(),
              "exitCode": None, "signal": None, "timedOut": False, "cancelled": False, "error": None}
    state = {"process": None}

    def cancel(signum, frame):
        result["cancelled"] = True
        if state["process"] is not None:
            stop_group(state["process"], 5)

    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    started = time.monotonic()
    try:
        tmp_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        tmpdir.mkdir(mode=0o700)
        environment = dict(os.environ, TMPDIR=str(tmpdir), TMP=str(tmpdir), TEMP=str(tmpdir))
        with (job_dir / "stdout.log").open("wb") as out, (job_dir / "stderr.log").open("wb") as err:
            process = subprocess.Popen(spec["argv"], cwd=spec["workdir"], env=environment,
                                       stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                       start_new_session=True)
            state["process"] = process
            deadline = started + spec["timeoutSeconds"]
            while True:
                try:
                    code = process.wait(timeout=1)
                    break
                except subprocess.TimeoutExpired:
                    if result["cancelled"]:
                        code = process.wait()
                        break
                    if time.monotonic() > deadline:
                        result["timedOut"] = True
                        stop_group(process)
                        code = process.wait()
                        break
        if code < 0:
            result["signal"] = signal.Signals(-code).name
        else:
            result["exitCode"] = code
    except (OSError, ValueError, JobError) as error:
        result["error"] = type(error).__name__ if not isinstance(error, JobError) else str(error)
    finally:
        try:
            shutil.rmtree(tmpdir)
        except FileNotFoundError:
            pass
        except OSError as error:
            result["tmpdirError"] = type(error).__name__
        result["tmpdirRemoved"] = not tmpdir.exists()
        for name in ("stdout", "stderr"):
            log = job_dir / (name + ".log")
            result[name] = file_digest(log) if log.exists() else {"bytes": 0, "sha256": None}
        result["versions"] = tool_versions()
        result["finishedAt"] = now()
        result["durationSeconds"] = round(time.monotonic() - started, 3)
        write_atomic(job_dir / "result.json", json.dumps(result, indent=2) + "\n")


def supervisor_alive(job_dir, job_id):
    try:
        pid = int((job_dir / "supervisor.pid").read_text().strip())
        os.kill(pid, 0)
    except (OSError, ValueError):
        return False
    command_line = Path("/proc") / str(pid) / "cmdline"
    if command_line.exists():
        # Guard against a reused process id on Linux.
        return b"_supervise" in command_line.read_bytes() and job_id.encode() in command_line.read_bytes()
    return True


def command_status(args):
    jobs_root, _ = roots(args)
    job_dir = job_directory(jobs_root, args.job_id)
    if not job_dir.is_dir():
        print(json.dumps({"jobId": args.job_id, "state": "MISSING"}))
        return
    out = {"jobId": args.job_id, "spec": json.loads((job_dir / "spec.json").read_text(encoding="utf-8"))}
    if (job_dir / "result.json").exists():
        out["state"] = "FINISHED"
        out["result"] = json.loads((job_dir / "result.json").read_text(encoding="utf-8"))
    else:
        out["state"] = "RUNNING" if supervisor_alive(job_dir, args.job_id) else "DEAD_WITHOUT_RESULT"
        for name in ("stdout", "stderr"):
            log = job_dir / (name + ".log")
            out[name + "Bytes"] = log.stat().st_size if log.exists() else 0
    print(json.dumps(out))


def command_collect(args):
    jobs_root, _ = roots(args)
    job_dir = job_directory(jobs_root, args.job_id)
    if not FILE_NAME.fullmatch(args.file):
        raise JobError("INVALID_FILE_NAME")
    path = job_dir / args.file
    if path.is_symlink() or not path.is_file():
        raise JobError("FILE_MISSING")
    if not 1 <= args.limit <= CHUNK_MAX:
        raise JobError("INVALID_LIMIT")
    whole = file_digest(path)
    offset = max(0, whole["bytes"] - args.tail) if args.tail is not None else args.offset
    if offset < 0 or offset > whole["bytes"]:
        raise JobError("INVALID_OFFSET")
    with path.open("rb") as stream:
        stream.seek(offset)
        data = stream.read(args.limit)
    print(json.dumps({"jobId": args.job_id, "name": args.file, "size": whole["bytes"], "sha256": whole["sha256"],
                      "offset": offset, "bytes": len(data), "chunkSha256": hashlib.sha256(data).hexdigest(),
                      "dataBase64": base64.b64encode(data).decode("ascii")}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("start", "_supervise", "status", "collect"):
        sub = commands.add_parser(name)
        sub.add_argument("--job-id", required=True)
        sub.add_argument("--jobs-root")
        sub.add_argument("--tmp-root")
        if name == "start":
            sub.add_argument("--timeout", type=int, required=True)
            sub.add_argument("--workdir", required=True)
            sub.add_argument("argv", nargs=argparse.REMAINDER)
        if name == "collect":
            sub.add_argument("--file", required=True)
            sub.add_argument("--offset", type=int, default=0)
            sub.add_argument("--tail", type=int)
            sub.add_argument("--limit", type=int, default=CHUNK_MAX)
    args = parser.parse_args()
    handlers = {"start": command_start, "_supervise": command_supervise,
                "status": command_status, "collect": command_collect}
    try:
        handlers[args.command](args)
    except JobError as error:
        print(json.dumps({"error": str(error)}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()

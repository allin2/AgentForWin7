#!/usr/bin/env python3
"""Private, time-bounded interactive agent login on a disposable Linux Box.

Run outside the checkout. No model requests are made. Read logs locally on the
Box; do not copy raw login output into reports or source control.
"""
import argparse
import json
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import time


def run(agent, directory):
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    master, slave = pty.openpty()
    command = (["claude", "auth", "login", "--claudeai"] if agent == "claude"
               else ["codex", "login", "--device-auth"])
    env = dict(os.environ)
    for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
                "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "OPENAI_BASE_URL"):
        env.pop(key, None)
    child = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave,
                             env=env, start_new_session=True)
    os.close(slave)
    (directory / "process.json").write_text(json.dumps({"supervisorPid": os.getpid(), "pid": child.pid}))
    deadline = time.monotonic() + 900
    interrupted = False

    def stop(signum, frame):
        nonlocal interrupted
        interrupted = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        with (directory / "login.log").open("xb", buffering=0) as log:
            while child.poll() is None and time.monotonic() < deadline and not interrupted:
                if select.select([master], [], [], 0.2)[0]:
                    try:
                        data = os.read(master, 65536)
                    except OSError:
                        break
                    if not data:
                        break
                    log.write(data)
                code_file = directory / "input"
                if code_file.exists():
                    # This private file is uploaded by the Mac only after an owner action.
                    try:
                        data = code_file.read_bytes()
                    finally:
                        code_file.unlink()
                    if b"\n" in data.strip() or len(data) > 16384:
                        raise ValueError("INVALID_LOGIN_INPUT")
                    remaining = memoryview(data.strip() + b"\n")
                    while remaining:
                        written = os.write(master, remaining)
                        remaining = remaining[written:]
                    del data, remaining
            if child.poll() is not None:
                while select.select([master], [], [], 0)[0]:
                    try:
                        data = os.read(master, 65536)
                    except OSError:
                        break
                    if not data:
                        break
                    log.write(data)
    finally:
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
            except ProcessLookupError:
                child.wait()
        os.close(master)
        (directory / "input").unlink(missing_ok=True)
        (directory / "result.json").write_text(json.dumps({
            "exitCode": child.returncode, "deadlineReached": time.monotonic() >= deadline,
            "interrupted": interrupted,
        }))


if __name__ == "__main__":
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("agent", choices=["claude", "codex"])
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    run(args.agent, args.directory)

#!/usr/bin/env python3
"""Run Antigravity onboarding in a private PTY, without submitting a prompt.

The raw PTY log can contain authorization codes. Keep it on the Box and remove
it after login. The supervisor exits after 15 minutes or an explicit stop file.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import termios
import time


def run(directory):
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    workspace = directory / "empty-workspace"
    workspace.mkdir(mode=0o700)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    env = dict(os.environ, TERM="xterm-256color")
    for key in ("GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS",
                "AGY_ADC_AUTH", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY"):
        env.pop(key, None)
    child = subprocess.Popen([str(Path.home() / ".local/bin/agy")],
                             stdin=slave, stdout=slave, stderr=slave,
                             cwd=workspace, env=env, start_new_session=True)
    os.close(slave)
    (directory / "process.json").write_text(json.dumps({
        "supervisorPid": os.getpid(), "pid": child.pid,
    }), encoding="utf-8")
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
                if (directory / "stop").exists():
                    break
                if select.select([master], [], [], 0.2)[0]:
                    try:
                        data = os.read(master, 65536)
                    except OSError:
                        break
                    if not data:
                        break
                    log.write(data)
                    # Answer terminal capability probes, not application prompts.
                    if b"\x1b[6n" in data:
                        os.write(master, b"\x1b[1;1R")
                input_file = directory / "input"
                if input_file.exists():
                    try:
                        data = input_file.read_bytes()
                    finally:
                        input_file.unlink()
                    if not data or len(data) > 16384:
                        raise ValueError("INVALID_LOGIN_INPUT")
                    remaining = memoryview(data)
                    while remaining:
                        remaining = remaining[os.write(master, remaining):]
                    del data, remaining
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
            "exitCode": child.returncode,
            "deadlineReached": time.monotonic() >= deadline,
            "interrupted": interrupted,
        }), encoding="utf-8")


if __name__ == "__main__":
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    run(parser.parse_args().directory)

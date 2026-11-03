#!/usr/bin/env python3
"""Emit development input hashes separately from the observed runtime identity."""
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import sys

INPUTS = (
    ".nvmrc", "package-lock.json", "src/core/package-lock.json",
    "src/gateway/package-lock.json", "src/git-adapter/package-lock.json",
    "src/runner/package-lock.json", "src/shell/package-lock.json",
    "src/shell/office-lite/package-lock.json", "src/state/package-lock.json",
    "src/workspace/package-lock.json", "scripts/instabox/prepare-linux.sh",
    "scripts/instabox/fingerprint.py", "scripts/instabox/env.sh",
)


def input_fingerprint(root):
    hashes = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in INPUTS}
    encoded = json.dumps(hashes, sort_keys=True, separators=(",", ":")).encode()
    return {"files": hashes, "sha256": hashlib.sha256(encoded).hexdigest()}


def version(argv):
    try:
        result = subprocess.run(argv, capture_output=True, text=True, check=True, timeout=15)
        return result.stdout.strip()
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None


if __name__ == "__main__":
    root = Path(sys.argv[1]).resolve(strict=True)
    print(json.dumps({
        "schemaVersion": 1, "evidenceLevel": "开发机",
        "inputs": input_fingerprint(root),
        "runtime": {"system": platform.system(), "machine": platform.machine(),
                    "node": version(["node", "--version"]),
                    "npm": version(["npm", "--version"]),
                    "claude": version(["claude", "--version"]),
                    "codex": version(["codex", "--version"])},
        "sourceCommit": version(["git", "-C", str(root), "rev-parse", "HEAD"]),
    }, ensure_ascii=False, indent=2))

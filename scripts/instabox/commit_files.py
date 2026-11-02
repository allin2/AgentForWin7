#!/usr/bin/env python3
"""Deterministic wrapper commit for an owner-approved work package.

The Mac supplies an exact manifest after inspecting the employee's recovered diff.
This program creates one local commit, without fetching, pushing or model calls.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import sys

sys.dont_write_bytecode = True
ATTRIBUTION = "Co-Authored-By: Claude Code <noreply@anthropic.com>"
SHARED = {"docs/STATUS.md", "docs/STATUS_LOG.md", "docs/tasks/README.md",
          "docs/DECISIONS.md", "docs/DECISIONS_INDEX.md"}
PROTECTED = {".git", ".agents", ".codex", ".aws"}


class Rejected(Exception):
    pass


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def commit(work, manifest_bytes):
    work = Path(work).resolve(strict=True)
    spec = json.loads(manifest_bytes)
    if spec.get("schemaVersion") != 1:
        raise Rejected("MANIFEST_VERSION")
    base, branch, subject = spec["base"], spec["branch"], spec["subject"]
    if (len(base) != 40 or any(c not in "0123456789abcdef" for c in base)
            or not branch.startswith("box/") or not subject.strip()
            or len(subject) > 200 or "\n" in subject or "\r" in subject):
        raise Rejected("MANIFEST_IDENTITY")
    expected = {}
    for item in spec["files"]:
        name = item["path"]
        path = PurePosixPath(name)
        if (not name or str(path) != name or path.is_absolute() or ".." in path.parts
                or any(p in PROTECTED for p in path.parts) or name in SHARED
                or "\x00" in name or name in expected):
            raise Rejected("MANIFEST_PATH")
        content_hash, mode = item["sha256"], item["mode"]
        if content_hash is None:
            if mode is not None:
                raise Rejected("MANIFEST_MODE")
        elif (len(content_hash) != 64 or any(c not in "0123456789abcdef" for c in content_hash)
              or mode not in ("100644", "100755")):
            raise Rejected("MANIFEST_HASH_OR_MODE")
        expected[name] = (content_hash, mode)
    if not expected:
        raise Rejected("NO_FILES")

    def git(*args, data=None):
        done = subprocess.run(["git", "--no-pager", "--literal-pathspecs", "-C", str(work),
                               "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
                               "-c", "commit.gpgsign=false", *args], input=data,
                              capture_output=True, timeout=60)
        if done.returncode:
            raise Rejected("GIT_" + args[0].upper().replace("-", "_"))
        return done.stdout

    def text(*args):
        return git(*args).decode("utf-8").strip()

    def paths(*args):
        return {p.decode("utf-8") for p in git(*args).split(b"\0") if p}

    if Path(text("rev-parse", "--show-toplevel")).resolve() != work:
        raise Rejected("WORK_ROOT")
    if text("rev-parse", "HEAD") != base:
        raise Rejected("HEAD_CHANGED")
    if text("symbolic-ref", "--short", "HEAD") != branch:
        raise Rejected("BRANCH_CHANGED")
    if git("diff", "--cached", "--name-only", "-z"):
        raise Rejected("INDEX_NOT_EMPTY")
    changed = paths("diff", "--no-renames", "--name-only", "-z", "HEAD")
    changed |= paths("ls-files", "--others", "--exclude-standard", "-z")
    if changed != set(expected):
        raise Rejected("CHANGED_PATHS_MISMATCH")

    for name, (wanted_hash, wanted_mode) in expected.items():
        target = work / name
        for parent in target.parents:
            if parent == work:
                break
            if parent.is_symlink():
                raise Rejected("SYMLINK_PARENT")
        if wanted_hash is None:
            if target.exists() or target.is_symlink():
                raise Rejected("EXPECTED_DELETION")
        else:
            info = target.lstat()
            if not stat.S_ISREG(info.st_mode):
                raise Rejected("REGULAR_FILES_ONLY")
            mode = "100755" if info.st_mode & 0o111 else "100644"
            if mode != wanted_mode or sha256(target.read_bytes()) != wanted_hash:
                raise Rejected("WORK_BYTES_OR_MODE_CHANGED")
    # Literal pathspecs prevent ':' or glob characters from widening the manifest.
    git("add", "-A", "--", *sorted(expected))
    if paths("diff", "--cached", "--no-renames", "--name-only", "-z") != set(expected):
        raise Rejected("STAGED_PATHS_MISMATCH")
    staged = {}
    for record in git("ls-files", "--stage", "-z").split(b"\0"):
        if not record:
            continue
        metadata, name = record.split(b"\t", 1)
        mode, oid, stage = metadata.decode("ascii").split()
        if stage != "0":
            raise Rejected("UNMERGED_INDEX")
        staged[name.decode("utf-8")] = (mode, oid)
    for name, (wanted_hash, wanted_mode) in expected.items():
        if wanted_hash is None:
            if name in staged:
                raise Rejected("STAGED_DELETION_MISMATCH")
        else:
            mode, oid = staged[name]
            if mode != wanted_mode or sha256(git("cat-file", "blob", oid)) != wanted_hash:
                raise Rejected("STAGED_BYTES_OR_MODE_CHANGED")
    # Recheck identity after staging. On any rejection, keep the machine and index.
    if text("rev-parse", "HEAD") != base or text("symbolic-ref", "--short", "HEAD") != branch:
        raise Rejected("IDENTITY_CHANGED_BEFORE_COMMIT")
    message = subject.strip() + "\n\n" + ATTRIBUTION + "\n"
    git("commit", "--quiet", "-F", "-", data=message.encode("utf-8"))
    result = text("rev-parse", "HEAD")
    if text("rev-list", "--parents", "-n", "1", result).split() != [result, base]:
        raise Rejected("COMMIT_PARENT_MISMATCH")
    if git("status", "--porcelain=v1", "-z"):
        raise Rejected("WORK_NOT_CLEAN_AFTER_COMMIT")
    return {"schemaVersion": 1, "base": base, "commit": result, "branch": branch,
            "manifestSha256": sha256(manifest_bytes), "files": spec["files"],
            "status": "COMMITTED", "push": "NOT_PERFORMED"}


def main():
    try:
        result = commit(sys.argv[1], Path(sys.argv[2]).read_bytes())
    except (Rejected, OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        # Do not print Git stderr, file content, credentials or personal configuration.
        reason = str(error) if isinstance(error, Rejected) else type(error).__name__
        print(json.dumps({"status": "REJECTED", "reason": reason, "machineKept": True}))
        raise SystemExit(1)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()

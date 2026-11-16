"""Verify model attribution in real wrapper commits without changing permissions."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import commit_files


class AttributionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="win7-eng06-commit-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.git("init", "-q")
        self.git("config", "user.name", "Work package test")
        self.git("config", "user.email", "test@localhost.invalid")
        (self.root / "base.txt").write_text("baseline\n", encoding="utf-8")
        self.git("add", "--", "base.txt")
        self.git("commit", "-qm", "baseline")
        self.base = self.git("rev-parse", "HEAD").strip()
        self.git("checkout", "-qb", "box/probe")
        data = b"verified\n"
        (self.root / "result.txt").write_bytes(data)
        self.spec = {"schemaVersion": 1, "base": self.base, "branch": "box/probe", "subject": "Verified output",
                     "files": [{"path": "result.txt", "sha256": hashlib.sha256(data).hexdigest(), "mode": "100644"}]}

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.root), *args], check=True,
                              capture_output=True, text=True, timeout=20).stdout

    def test_codex_commit_records_codex_and_exact_parent(self):
        self.spec["agent"] = "codex"
        result = commit_files.commit(self.root, json.dumps(self.spec).encode())
        message = self.git("log", "-1", "--format=%B")
        self.assertIn("Co-Authored-By: Codex <noreply@openai.com>", message)
        self.assertNotIn("Claude", message)
        self.assertEqual(self.git("rev-parse", "HEAD^").strip(), self.base)
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertEqual(result["commit"], self.git("rev-parse", "HEAD").strip())

    def test_legacy_manifest_keeps_claude_attribution(self):
        commit_files.commit(self.root, json.dumps(self.spec).encode())
        self.assertIn(commit_files.ATTRIBUTION, self.git("log", "-1", "--format=%B"))

    def test_unknown_agent_is_rejected_before_staging(self):
        self.spec["agent"] = "codex\nInjected: message"
        with self.assertRaisesRegex(commit_files.Rejected, "MANIFEST_AGENT"):
            commit_files.commit(self.root, json.dumps(self.spec).encode())
        self.assertEqual(self.git("rev-parse", "HEAD").strip(), self.base)
        self.assertEqual(self.git("diff", "--cached", "--name-only"), "")


if __name__ == "__main__":
    unittest.main()

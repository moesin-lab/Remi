"""Archive identity and extraction regression tests; run with python3 -I."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
import sys

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).with_name("verify-release-source.py")
spec = importlib.util.spec_from_file_location("release_source_verifier", SCRIPT)
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
COMMIT = "a" * 40
PREFIX = "remi-v1.2.3"


class SourceArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        (self.source / "package.json").write_text('{"version":"1.2.3"}\n')
        (self.source / "bin").mkdir()
        (self.source / "bin" / "run").write_text("#!/bin/sh\nexit 0\n")
        (self.source / "bin" / "run").chmod(0o755)
        os.symlink("../package.json", self.source / "bin" / "link")
        subprocess.run(["git", "init", "-q", str(self.source)], check=True)
        subprocess.run(["git", "-C", str(self.source), "add", "."], check=True)
        self.tree = subprocess.check_output(["git", "-C", str(self.source), "write-tree"], text=True).strip()
        self.entries = [
            ("package.json", tarfile.REGTYPE, 0o644, (self.source / "package.json").read_bytes(), ""),
            ("bin/run", tarfile.REGTYPE, 0o755, (self.source / "bin/run").read_bytes(), ""),
            ("bin/link", tarfile.SYMTYPE, 0o777, b"", "../package.json"),
        ]

    def archive(self, entries=None, commit=COMMIT):
        archive = self.root / "archive.tar.gz"
        with tarfile.open(archive, "w:gz", format=tarfile.PAX_FORMAT, pax_headers={"comment": commit}) as tar:
            for name, kind, mode, data, link in self.entries if entries is None else entries:
                member = tarfile.TarInfo(PREFIX + "/" + name)
                member.type, member.mode, member.size, member.linkname = kind, mode, len(data), link
                tar.addfile(member, io.BytesIO(data))
        return archive, hashlib.sha256(archive.read_bytes()).hexdigest()

    def check(self, entries=None, commit=COMMIT, digest=None, tree=None):
        archive, actual = self.archive(entries, commit)
        return verifier.verify(archive, digest or actual, COMMIT, tree or self.tree, PREFIX)

    def test_matches_git_tree_including_executable_and_symlink(self):
        files, tree = self.check()
        self.assertEqual(tree, self.tree)
        self.assertEqual(len(files), 3)

    def test_digest_pax_and_full_tree_are_independent_requirements(self):
        for kwargs in ({"digest": "0" * 64}, {"commit": "b" * 40}, {"tree": "0" * 40}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.check(**kwargs)
        changed = list(self.entries)
        changed[0] = ("package.json", tarfile.REGTYPE, 0o644, b"changed", "")
        with self.assertRaisesRegex(ValueError, "Git tree mismatch"):
            self.check(changed)
        changed = list(self.entries)
        changed[1] = ("bin/run", tarfile.REGTYPE, 0o644, changed[1][3], "")
        with self.assertRaisesRegex(ValueError, "Git tree mismatch"):
            self.check(changed)

    def test_rejects_traversal_duplicates_special_files_and_link_parents(self):
        cases = [
            self.entries + [("../../escape", tarfile.REGTYPE, 0o644, b"x", "")],
            self.entries + [self.entries[0]],
            self.entries + [("hard", tarfile.LNKTYPE, 0o644, b"", "package.json")],
            self.entries + [("fifo", tarfile.FIFOTYPE, 0o644, b"", "")],
            self.entries + [("bad", tarfile.SYMTYPE, 0o777, b"", "../../escape")],
            self.entries + [("bin/link/child", tarfile.REGTYPE, 0o644, b"x", "")],
            self.entries + [(".git/config", tarfile.REGTYPE, 0o644, b"x", "")],
            self.entries + [("root", tarfile.SYMTYPE, 0o777, b"", "."),
                            ("indirect", tarfile.SYMTYPE, 0o777, b"", "root/../escape")],
            self.entries + [("cycle", tarfile.SYMTYPE, 0o777, b"", "cycle")],
        ]
        for entries in cases:
            with self.subTest(last=entries[-1][0]), self.assertRaises(ValueError):
                self.check(entries)

    def test_extract_only_after_verification_and_recheck_installed_source(self):
        archive, digest = self.archive()
        destination = self.root / "previous"
        args = ["python3", "-I", str(SCRIPT), str(archive), digest, COMMIT, self.tree, PREFIX]
        # A planted import alongside the input must never be loaded.
        (self.root / "json.py").write_text('raise Exception("untrusted import executed")')
        subprocess.run(args + [str(destination)], cwd=self.root, check=True, capture_output=True)
        self.assertTrue((destination / "bin/link").is_symlink())
        self.assertTrue((destination / "bin/run").stat().st_mode & 0o111)
        (destination / "node_modules").mkdir()
        (destination / "node_modules" / "downloaded").write_text("dependency")
        subprocess.run(args + ["--check-directory", str(destination)], check=True, capture_output=True)
        (destination / "package.json").write_text("tampered")
        result = subprocess.run(args + ["--check-directory", str(destination)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        bad = self.root / "bad"
        result = subprocess.run([*args[:6], "0" * 40, PREFIX, str(bad)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(bad.exists())


if __name__ == "__main__":
    unittest.main()

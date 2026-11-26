"""Verify a git archive in memory before extracting any published source.

Invoked with python3 -I from candidate code, never from the downloaded directory.
Only regular files, directories and in-tree symlinks are accepted. The entire
archive must reconstruct the trusted commit's Git tree, including file modes.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import tarfile


def git_hash(kind, data):
    return hashlib.sha1(f"{kind} {len(data)}\0".encode() + data).digest()


def verify(archive, expected_sha256, expected_commit, expected_tree, prefix):
    data = Path(archive).read_bytes()
    if hashlib.sha256(data).hexdigest() != expected_sha256:
        raise ValueError("Source archive SHA256 mismatch")
    files, directories, seen = {}, set(), set()
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        if tar.pax_headers.get("comment") != expected_commit:
            raise ValueError("Source archive PAX commit mismatch")
        for member in tar:
            raw_name = member.name.rstrip("/") if member.isdir() else member.name
            if raw_name == prefix and member.isdir():
                continue
            if not raw_name.startswith(prefix + "/"):
                raise ValueError("Unexpected source archive prefix")
            name = raw_name[len(prefix) + 1:]
            parts = PurePosixPath(name).parts
            if (not name or name.startswith("/") or "\\" in name
                    or any(p in ("", ".", "..", ".git") for p in name.split("/"))
                    or any(ord(c) < 32 for c in name) or name in seen):
                raise ValueError(f"Unsafe or duplicate archive path: {name!r}")
            seen.add(name)
            if member.isdir():
                directories.add(name)
                continue
            if member.isfile():
                if member.mode not in (0o644, 0o664, 0o755, 0o775):
                    raise ValueError(f"Unexpected file mode: {name}")
                content = tar.extractfile(member).read()
                mode = b"100755" if member.mode & 0o111 else b"100644"
            elif member.issym():
                target = member.linkname
                destination = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
                if (not target or target.startswith("/") or "\\" in target
                        or destination == ".." or destination.startswith("../")):
                    raise ValueError(f"Escaping archive symlink: {name}")
                content, mode = target.encode("utf-8"), b"120000"
            else:
                raise ValueError(f"Unsupported archive entry: {name}")
            files[name] = (mode, content)
            for i in range(1, len(parts)):
                directories.add("/".join(parts[:i]))
    if not files:
        raise ValueError("Empty source archive")
    if set(files) & directories:
        raise ValueError("Archive file/symlink is also a parent directory")
    # Resolve symlink chains before extraction, including '..' after a link to '.'.
    # Lexical normalization alone would miss that escape.
    for name, (mode, content) in files.items():
        if mode != b"120000":
            continue
        pending = name.split("/")[:-1] + content.decode("utf-8").split("/")
        resolved, links = [], 0
        while pending:
            part = pending.pop(0)
            if part in ("", "."):
                continue
            if part == "..":
                if not resolved:
                    raise ValueError(f"Escaping archive symlink chain: {name}")
                resolved.pop()
                continue
            resolved.append(part)
            entry = files.get("/".join(resolved))
            if entry and entry[0] == b"120000":
                links += 1
                if links > 40:
                    raise ValueError(f"Cyclic archive symlink: {name}")
                resolved.pop()
                pending = entry[1].decode("utf-8").split("/") + pending
    # Empty directories cannot be represented by Git and are not accepted either.
    if any(not any(f.startswith(d + "/") for f in files) for d in directories):
        raise ValueError("Unexpected empty archive directory")
    tree = {}
    for name, (mode, content) in files.items():
        parent = tree
        for part in name.split("/")[:-1]:
            parent = parent.setdefault(part, {})
        parent[name.split("/")[-1]] = (mode, git_hash("blob", content))

    def hash_tree(node):
        entries = []
        for name, value in node.items():
            key = name.encode("utf-8")
            mode, digest = (b"40000", hash_tree(value)) if isinstance(value, dict) else value
            entries.append((key + (b"/" if mode == b"40000" else b""), mode + b" " + key + b"\0" + digest))
        return git_hash("tree", b"".join(v for _, v in sorted(entries)))

    actual_tree = hash_tree(tree).hex()
    if actual_tree != expected_tree:
        raise ValueError(f"Source archive Git tree mismatch: {actual_tree} != {expected_tree}")
    return files, actual_tree


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("archive")
    parser.add_argument("sha256")
    parser.add_argument("commit")
    parser.add_argument("tree")
    parser.add_argument("prefix")
    parser.add_argument("destination", nargs="?")
    parser.add_argument("--check-directory")
    args = parser.parse_args()
    files, tree = verify(args.archive, args.sha256, args.commit, args.tree, args.prefix)
    if args.check_directory:
        root = Path(args.check_directory)
        actual = set()
        for parent, dirs, names in os.walk(root, followlinks=False):
            dirs[:] = [d for d in dirs if d != "node_modules"]
            for name in list(dirs):
                if (Path(parent) / name).is_symlink():
                    dirs.remove(name)
                    names.append(name)
            for name in names:
                path = Path(parent) / name
                relative = path.relative_to(root).as_posix()
                if relative == ".git" and path.is_file() and not path.is_symlink():
                    continue  # A normal tag worktree has a Git-owned pointer file.
                actual.add(relative)
        if actual != set(files):
            raise ValueError("Prepared source has missing or additional files")
        for name, (mode, content) in files.items():
            path = root / name
            if mode == b"120000":
                if not path.is_symlink() or os.readlink(path).encode("utf-8") != content:
                    raise ValueError(f"Prepared source symlink changed: {name}")
            elif (path.is_symlink() or not path.is_file() or path.read_bytes() != content
                    or bool(path.stat().st_mode & 0o111) != (mode == b"100755")):
                raise ValueError(f"Prepared source file changed: {name}")
    if args.destination:
        root = Path(args.destination)
        root.mkdir()  # Must be a new, empty destination; never overlay another tree.
        for name, (mode, content) in files.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            if mode == b"120000":
                os.symlink(content.decode("utf-8"), path)
            else:
                path.write_bytes(content)
                path.chmod(0o755 if mode == b"100755" else 0o644)
    print(json.dumps({"commit": args.commit, "tree": tree, "sha256": args.sha256, "entries": len(files)}))


if __name__ == "__main__":
    main()

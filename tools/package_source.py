#!/usr/bin/env python3
"""Build a source-only GitHub ZIP using explicit paths, never a workspace dump."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TOP = ["README.md", "ARCHITECTURE.md", "SETUP.md", "VALIDATION.md", "THIRD-PARTY.md", ".gitignore", "requirements-render.txt"]
TREES = {"perform": {".py"}, "ios": {".swift", ".plist", ".pbxproj"}, "pi": {".sh", ".service"},
         "tests": {".py"}, "tools": {".py"}, ".github": {".yml"}, "mac-app/UI": {".js", ".css", ".html"},
         "mac-app/Sources": {".swift"}, "mac-app/Tests": {".swift"}}


def source_files():
    files = [ROOT/p for p in TOP]
    files += [ROOT/"mac-app/Package.swift", ROOT/"mac-app/NOTO-MUSIC-GLYPH-LICENSE.txt", ROOT/"mac-app/Sources/PianoLibraryMac/Resources/.gitkeep"]
    for tree, suffixes in TREES.items():
        files += [p for p in (ROOT/tree).rglob("*") if p.is_file() and p.suffix in suffixes
                  and not any(part in ("xcuserdata", "__pycache__", "Resources") for part in p.relative_to(ROOT/tree).parts)]
    return sorted(set(files))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT/"dist/Piano-Library-Source.zip")
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    hashes = {}
    with zipfile.ZipFile(args.output, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in source_files():
            data = path.read_bytes()
            name = str(path.relative_to(ROOT))
            hashes[name] = hashlib.sha256(data).hexdigest()
            archive.writestr("Piano-Library/"+name, data)
        archive.writestr("Piano-Library/SOURCE-MANIFEST.json", json.dumps(hashes, indent=2)+"\n")
    print(f"{args.output}: {len(hashes)} source files; no score assets or credentials")


if __name__ == "__main__": main()

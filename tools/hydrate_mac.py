#!/usr/bin/env python3
"""Restore private Mac resources locally; they remain excluded from Git."""
import argparse
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--resources", type=Path, required=True, help="Existing approved Mac Resources folder")
args = parser.parse_args()
if not (args.resources/"collection.json").is_file():
    parser.error("Expected the existing Mac library Resources folder")
target = ROOT/"mac-app/Sources/PianoLibraryMac/Resources"
shutil.copytree(args.resources, target, dirs_exist_ok=True)
shutil.copytree(ROOT/"mac-app/UI", target/"UI", dirs_exist_ok=True)
print(f"Private library restored locally at {target}; do not force-add it to Git")

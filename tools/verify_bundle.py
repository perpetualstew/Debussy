#!/usr/bin/env python3
"""Verify a private export's hashes, routes, PNG decode and light/dark pixels."""
import argparse
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from PIL import Image, ImageChops, ImageOps
from perform.store import Store
from perform.model import references

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("bundle", type=Path)
args = parser.parse_args()
store = Store(args.bundle)
manifest = store.check(store.load())
checked = set()
maximum = (0, "", "")
for slug, piece in manifest["pieces"].items():
    for name, variant in piece["variants"].items():
        profile = manifest["profiles"][name]
        memory = profile["width"]*profile["height"]*len(variant["pages"])*8
        maximum = max(maximum,(memory,slug,name))
        for page in variant["pages"]:
            pair = (page["light"],page["dark"])
            if pair in checked: continue
            light = Image.open(store.path(pair[0])).convert("RGB")
            dark = Image.open(store.path(pair[1])).convert("RGB")
            if ImageChops.difference(ImageOps.invert(light),dark).getbbox():
                raise ValueError(f"Incorrect dark variant: {slug}/{name}")
            if not ImageChops.difference(light,Image.new("RGB",light.size,"white")).getbbox():
                raise ValueError(f"Blank score page: {slug}/{name}")
            checked.add(pair)
hashes = references(manifest)
report = dict(revision=manifest["revision"], pieces=len(manifest["pieces"]),
    profiles=len(manifest["profiles"]), uniquePNGs=len(hashes),
    bytes=sum(store.path(key).stat().st_size for key in hashes), checkedThemePairs=len(checked),
    largestCacheBytes=maximum[0],largestCachePiece=maximum[1],largestCacheProfile=maximum[2])
print(json.dumps(report,indent=2))

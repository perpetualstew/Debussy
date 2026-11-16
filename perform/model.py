"""Transport-independent manifest and alternating-page model. No rendering."""
import hashlib
import json
import re

HASH = re.compile(r"^[0-9a-f]{64}$")
ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,119}$")


def canonical(value):
    # JSON bridges (notably Foundation) serialize 1.0 as 1. Normalize that
    # representation before hashing so a phone relay preserves the revision.
    def normalize(item):
        if isinstance(item, float) and item.is_integer():
            return int(item)
        if isinstance(item, dict):
            return {k: normalize(v) for k, v in item.items()}
        if isinstance(item, list):
            return [normalize(v) for v in item]
        return item
    return json.dumps(normalize(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def validate(manifest):
    if manifest.get("schema") != 1 or not ID.fullmatch(manifest.get("library", "")):
        raise ValueError("Unsupported library manifest")
    content = {k: v for k, v in manifest.items() if k != "revision"}
    if manifest.get("revision") != digest(canonical(content)):
        raise ValueError("Manifest revision mismatch")
    pieces, profiles = manifest["pieces"], manifest["profiles"]
    if not 1 <= len(pieces) <= 1000 or not 1 <= len(profiles) <= 64:
        raise ValueError("Invalid library size")
    for name, profile in profiles.items():
        if not ID.fullmatch(name) or profile["slots"] not in (1, 2):
            raise ValueError("Invalid profile")
        for key in ("width", "height", "screenWidth", "screenHeight"):
            if type(profile[key]) is not int or not 100 <= profile[key] <= 8192:
                raise ValueError("Invalid display dimensions")
        if profile["arrangement"] not in ("dual-horizontal", "dual-vertical", "split-horizontal", "split-vertical", "single", "mirror"):
            raise ValueError("Invalid arrangement")
        expected = 2 if profile["arrangement"].startswith(("dual-", "split-")) else 1
        if expected != profile["slots"]:
            raise ValueError("Slot count does not match arrangement")
        if (profile["screenWidth"], profile["screenHeight"]) != (1080, 1920):
            raise ValueError("This release targets a fixed 1080×1920 panel raster")
        expected_shape = (1080, 960) if profile["arrangement"].startswith("split-") else (1080, 1920)
        if (profile["width"], profile["height"]) != expected_shape:
            raise ValueError("Raster does not fit fixed panel slots")
    for slug, piece in pieces.items():
        if not ID.fullmatch(slug) or not isinstance(piece["title"], str):
            raise ValueError("Invalid piece")
        if not piece["variants"]:
            raise ValueError("Piece has no presentations")
        for name, variant in piece["variants"].items():
            if name not in profiles or not 1 <= len(variant["pages"]) <= 500:
                raise ValueError("Invalid variant")
            cursor = 0
            for page in variant["pages"]:
                if page["start"] != cursor or type(page["end"]) is not int or page["end"] <= cursor:
                    raise ValueError("Discontinuous performance route")
                cursor = page["end"]
                for theme in ("light", "dark"):
                    if not HASH.fullmatch(page[theme]):
                        raise ValueError("Invalid image hash")
            if cursor != piece["routeLength"]:
                raise ValueError("Incomplete performance route")
    return manifest


def references(manifest):
    return {page[theme] for piece in manifest["pieces"].values()
            for variant in piece["variants"].values() for page in variant["pages"]
            for theme in ("light", "dark")}


class Pages:
    """A turn replaces the page just read, retaining the page being read."""
    def __init__(self, count, slots=2, step=0):
        if count < 1 or slots not in (1, 2):
            raise ValueError("Invalid page count")
        self.count, self.slots = count, slots
        self.step = max(0, min(step, self.maximum))

    @property
    def maximum(self):
        return max(0, self.count - self.slots)

    @property
    def visible(self):
        if self.slots == 1:
            return [self.step]
        pair = [2 * ((self.step + 1) // 2), 2 * (self.step // 2) + 1]
        return [i if i < self.count else None for i in pair]

    @property
    def reading(self):
        # 1/2 -> 3/2: the performer is now reading 2, not 3.
        return self.step

    def turn(self, amount):
        self.step = max(0, min(self.maximum, self.step + amount))

    @classmethod
    def at_visit(cls, pages, slots, visit):
        page = next((i for i, p in enumerate(pages) if p["start"] <= visit < p["end"]), len(pages) - 1)
        return cls(len(pages), slots, page)

"""Content-addressed disk cache. Interrupted transfers never replace live files."""
import base64
import json
import os
from pathlib import Path
import struct
from .model import HASH, canonical, digest, references, validate

MAX_OBJECT = 32 * 1024 * 1024


class Store:
    def __init__(self, root):
        self.root = Path(root)
        (self.root / "objects").mkdir(parents=True, exist_ok=True)
        (self.root / "incoming").mkdir(exist_ok=True)

    def path(self, key):
        if not isinstance(key, str) or not HASH.fullmatch(key):
            raise ValueError("Invalid content hash")
        return self.root / "objects" / (key + ".png")

    def begin(self, key, size):
        path = self.path(key)
        if type(size) is not int or not 1 <= size <= MAX_OBJECT:
            raise ValueError("Invalid PNG size")
        if path.exists() and path.stat().st_size == size and digest(path.read_bytes()) == key:
            return dict(offset=size, complete=True)
        temp = self.root / "incoming" / key
        if temp.exists() and temp.stat().st_size > size:
            temp.unlink()
        if not temp.exists():
            temp.touch()
        (self.root / "incoming" / (key + ".size")).write_text(str(size))
        return dict(offset=temp.stat().st_size, complete=False)

    def chunk(self, key, offset, encoded):
        self.path(key)
        temp = self.root / "incoming" / key
        size = int((self.root / "incoming" / (key + ".size")).read_text())
        data = base64.b64decode(encoded, validate=True)
        if not data or len(data) > 8192 or type(offset) is not int or offset < 0 or offset+len(data) > size:
            raise ValueError("Invalid transfer chunk")
        actual = temp.stat().st_size
        if offset < actual:
            with temp.open("rb") as stream:
                stream.seek(offset)
                if stream.read(len(data)) == data:
                    return dict(offset=actual)  # Safe replay after a lost ACK.
        if offset != actual:
            raise ValueError(f"Resume at offset {actual}")
        with temp.open("ab") as stream:
            stream.write(data)
        return dict(offset=offset+len(data))

    def finish(self, key):
        path = self.path(key)
        temp = self.root / "incoming" / key
        size = int((self.root / "incoming" / (key + ".size")).read_text())
        raw = temp.read_bytes()
        if len(raw) != size or digest(raw) != key:
            temp.unlink(missing_ok=True)
            raise ValueError("PNG checksum/length failed; restart this object")
        png_dimensions(raw)
        with temp.open("rb") as stream:
            os.fsync(stream.fileno())
        os.replace(temp, path)
        (self.root / "incoming" / (key + ".size")).unlink()
        return dict(complete=True)

    def check(self, manifest):
        validate(manifest)
        dimensions = {}
        for key in references(manifest):
            raw = self.path(key).read_bytes()
            if digest(raw) != key:
                raise ValueError(f"Corrupt object {key}")
            dimensions[key] = png_dimensions(raw)
        for piece in manifest["pieces"].values():
            for name, variant in piece["variants"].items():
                profile = manifest["profiles"][name]
                for page in variant["pages"]:
                    for theme in ("light", "dark"):
                        if dimensions[page[theme]] != (profile["width"], profile["height"]):
                            raise ValueError("PNG dimensions disagree with profile")
        return manifest

    def commit(self, manifest):
        # Caller validates and prepares the current piece before committing.
        path = self.root / "manifest.pending"
        with path.open("wb") as stream:
            stream.write(canonical(manifest))
            stream.flush()
            os.fsync(stream.fileno())
        current = self.root / "manifest.json"
        if current.exists():
            (self.root / "manifest.previous.json").write_bytes(current.read_bytes())
        os.replace(path, current)

    def load(self):
        return validate(json.loads((self.root / "manifest.json").read_text()))


def png_dimensions(raw):
    if len(raw) < 33 or raw[:8] != b"\x89PNG\r\n\x1a\n" or raw[12:16] != b"IHDR":
        raise ValueError("Expected a PNG")
    width, height = struct.unpack(">II", raw[16:24])
    if not 1 <= width <= 8192 or not 1 <= height <= 8192:
        raise ValueError("PNG exceeds display limits")
    return width, height

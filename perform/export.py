"""Run on the Mac only: approved finished SVGs -> immutable PNG library."""
import argparse
import io
import json
import os
from pathlib import Path
import re
import xml.etree.ElementTree as ET
from .model import canonical, digest, validate

NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", NS)


def profiles():
    layouts = [
        ("dual-portrait", "Two portrait screens · left/right", 1080, 1920, 1080, 1920, 2, "dual-horizontal"),
        ("dual-landscape", "Two landscape screens · top/bottom", 1920, 1080, 1920, 1080, 2, "dual-vertical"),
        ("split-landscape", "One landscape screen · left/right", 960, 1080, 1920, 1080, 2, "split-horizontal"),
        ("split-portrait", "One portrait screen · top/bottom", 1080, 960, 1080, 1920, 2, "split-vertical"),
        ("single-portrait", "One portrait page", 1080, 1920, 1080, 1920, 1, "single"),
        ("single-landscape", "One landscape page", 1920, 1080, 1920, 1080, 1, "single"),
        ("mirror-portrait", "One portrait page · mirrored", 1080, 1920, 1080, 1920, 1, "mirror"),
        ("mirror-landscape", "One landscape page · mirrored", 1920, 1080, 1920, 1080, 1, "mirror"),
    ]
    # Pi stays in its existing two-portrait-panel desktop configuration.
    # Landscape notation is rotated clockwise here; the user turns the panel
    # counterclockwise physically. No display settings or pixel transforms on Pi.
    return {f"{key}-{size}": dict(label=f"{label} · {size}",
            width=h if "landscape" in key else w, height=w if "landscape" in key else h,
            pageWidth=w, pageHeight=h, pixelRotation=90 if "landscape" in key else 0,
            screenWidth=1080, screenHeight=1920, slots=slots, arrangement=arrangement,
            scale=scale) for key, label, w, h, sw, sh, slots, arrangement in layouts
            for size, scale in [("standard", .78), ("large", 1.0)]}


def slice_svg(system, part):
    root = ET.fromstring(system["svg"])
    # Match the Mac's approved finished-slice renderer, including overflow.
    for node in root.iter():
        if node.tag == f"{{{NS}}}svg":
            node.set("overflow", "visible")
            node.set("style", node.get("style", "") + ";overflow:visible")
    for parent in list(root.iter()):
        for node in list(parent):
            classes = set(node.get("class", "").split())
            if classes & {"dir", "repeatMark", "segno", "coda"}:
                text = " ".join(node.itertext()) + " " + node.get("class", "")
                if re.search(r"d\s*\.\s*s\s*\.|to\s*coda|segno|coda", text, re.I) or any(
                        set(n.get("class", "").split()) & {"segno", "coda"} for n in node.iter()):
                    parent.remove(node)
    w, h = system["width"], system["height"]
    if part["first"] != system["first"] or part["last"] != system["last"]:
        left = 0 if part["first"] == system["first"] else system["barlines"][part["first"] - system["first"]]
        right = w if part["last"] == system["last"] else system["barlines"][part["last"] - system["first"] + 1]
        group = ET.Element(f"{{{NS}}}g", {"clip-path": "url(#performance-cut)"})
        for child in list(root):
            root.remove(child)
            group.append(child)
        defs = ET.SubElement(root, f"{{{NS}}}defs")
        clip = ET.SubElement(defs, f"{{{NS}}}clipPath", {"id": "performance-cut", "clipPathUnits": "userSpaceOnUse"})
        ET.SubElement(clip, f"{{{NS}}}rect", {"x": str(left-.8), "y": "-20", "width": str(right-left+1.6), "height": str(h+40)})
        root.append(group)
    root.set("viewBox", f"-12 -20 {w+24} {h+40}")
    root.set("width", str(w+24))
    root.set("height", str(h+40))
    return ET.tostring(root)


def write_object(output, image):
    stream = io.BytesIO()
    image.save(stream, format="PNG")
    raw = stream.getvalue()
    key = digest(raw)
    path = output / "objects" / f"{key}.png"
    if not path.exists():
        path.write_bytes(raw)
    return key


def render_variant(score, profile, output):
    import cairosvg
    from PIL import Image, ImageOps
    w, h = profile["pageWidth"], profile["pageHeight"]
    target = round((w - 32) * profile["scale"])
    pages, rows, used, cursor = [], [], 0, 0

    def flush():
        canvas = Image.new("RGB", (w, h), "white")
        y = (h - sum(row.height for row, _, _ in rows) - 16 * (len(rows)-1)) // 2
        for row, _, _ in rows:
            canvas.paste(row, ((w-row.width)//2, y), row)
            y += row.height + 16
        if profile["pixelRotation"] == 90:
            canvas = canvas.transpose(Image.Transpose.ROTATE_270)
        pages.append(dict(start=rows[0][1], end=rows[-1][2], light=write_object(output, canvas),
                          dark=write_object(output, ImageOps.invert(canvas))))

    for part in score["performance"]:
        system = score["systems"][part["systemId"]]
        raw = cairosvg.svg2png(bytestring=slice_svg(system, part), output_width=target)
        row = Image.open(io.BytesIO(raw)).convert("RGBA")
        if row.height > h - 64:
            raise ValueError("An approved system is too tall for this profile; choose a smaller scale on the Mac")
        if rows and used + 16 + row.height > h - 64:
            flush()
            rows, used = [], 0
        end = cursor + part["last"] - part["first"] + 1
        rows.append((row, cursor, end))
        used += row.height + (16 if len(rows) > 1 else 0)
        cursor = end
    if rows:
        flush()
    return dict(pages=pages)


def export(resources, output, slugs=None, selected=None):
    output.mkdir(parents=True, exist_ok=True)
    (output / "objects").mkdir(exist_ok=True)
    approved = json.loads((resources / "UI" / "finished-pieces.json").read_text())
    # The active Mac file is an array of approved slugs.
    if isinstance(approved, dict):
        approved = approved.get("pieces", approved.get("slugs", list(approved)))
    all_profiles = profiles()
    selected = selected or list(all_profiles)
    manifest = dict(schema=1, library="piano-library", profiles={k: all_profiles[k] for k in selected}, pieces={})
    collection = json.loads((resources / "collection.json").read_text())
    entries = collection if isinstance(collection, list) else collection["pieces"]
    titles = {p["slug"]: p["title"] for p in entries}
    for slug in slugs or approved:
        if slug not in approved:
            raise ValueError(f"{slug} is not an approved finished piece")
        source = (resources / "finished" / f"{slug}.json").read_bytes()
        score = json.loads(source)
        piece = dict(title=titles[slug], sourceSha256=digest(source),
                     routeLength=sum(p["last"]-p["first"]+1 for p in score["performance"]), variants={})
        rendered = {}
        for name, profile in manifest["profiles"].items():
            shape = (profile["pageWidth"], profile["pageHeight"], profile["scale"], profile["pixelRotation"])
            if shape not in rendered:
                print(f"Rendering {slug}: {name}", flush=True)
                rendered[shape] = render_variant(score, profile, output)
            piece["variants"][name] = rendered[shape]
        manifest["pieces"][slug] = piece
    manifest["revision"] = digest(canonical(manifest))
    validate(manifest)
    temp = output / "manifest.pending"
    temp.write_bytes(canonical(manifest))
    os.replace(temp, output / "manifest.json")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resources", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--piece", action="append")
    parser.add_argument("--profile", action="append", choices=list(profiles()))
    args = parser.parse_args()
    result = export(args.resources, args.output, args.piece, args.profile)
    print(f"Exported {len(result['pieces'])} pieces; revision {result['revision']}")

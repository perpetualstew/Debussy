import base64
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from PIL import Image, ImageChops, ImageOps
from perform.export import profiles, render_variant
from perform.model import Pages, canonical, digest, references, validate
from perform.player import Player
from perform.presenter import placements
from perform.store import Store


def png(width=1080, height=1920):
    out = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(out, format="PNG")
    return out.getvalue()


def fixture(key, count=6):
    profile = profiles()["dual-portrait-standard"]
    pages = [dict(start=i*4, end=(i+1)*4, light=key, dark=key) for i in range(count)]
    manifest = dict(schema=1, library="test", profiles={"normal": profile, "alternate": profile},
                    pieces={"original": dict(title="Original test", routeLength=count*4,
                        variants={"normal": dict(pages=pages), "alternate": dict(pages=pages)})})
    manifest["revision"] = digest(canonical(manifest))
    return manifest


class NavigationTests(unittest.TestCase):
    def test_alternation_and_reverse(self):
        pages = Pages(6)
        expected = [[0,1], [2,1], [2,3], [4,3], [4,5]]
        for pair in expected:
            self.assertEqual(pages.visible, pair)
            pages.turn(1)
        self.assertEqual(pages.visible, expected[-1])
        for pair in expected[::-1]:
            self.assertEqual(pages.visible, pair)
            pages.turn(-1)
        self.assertEqual(pages.visible, expected[0])

    def test_odd_and_single(self):
        for count in range(1, 12):
            p = Pages(count)
            for _ in range(count+3):
                self.assertTrue(all(i is None or 0 <= i < count for i in p.visible))
                p.turn(1)
            self.assertIn(count-1, p.visible)
        self.assertEqual(Pages(1).visible, [0, None])
        p = Pages(3, 1)
        for i in range(3):
            self.assertEqual(p.visible, [i]); p.turn(1)

    def test_layout_preserves_reading_visit_and_theme_preserves_turn(self):
        manifest = fixture("a"*64)
        manifest["pieces"]["original"]["variants"]["alternate"]["pages"] = [
            dict(start=i*2, end=(i+1)*2, light="a"*64, dark="a"*64) for i in range(12)]
        player = Player(manifest, dict(profile="normal"))
        player.command(dict(op="next"))  # 3/2, currently reading page 2
        player.command(dict(op="select", theme="dark"))
        self.assertEqual(player.pages.visible, [2,1])
        self.assertEqual(player.visit, 4)
        player.command(dict(op="select", profile="alternate"))
        self.assertEqual(player.visit, 4)
        player.command(dict(op="goto", page=7))
        self.assertIn(6, player.pages.visible)
        with self.assertRaises(ValueError): player.command(dict(op="goto", page=99))

    def test_physical_orientation_never_changes_desktop_positions(self):
        for name, profile in profiles().items():
            layout = placements(profile)
            self.assertEqual([(x,y,w,h) for x,y,w,h,_ in layout], [(0,0,1080,1920),(1080,0,1080,1920)])
            for _,_,w,h,slots in layout:
                for _,x,y in slots:
                    self.assertLessEqual(x+profile["width"],w)
                    self.assertLessEqual(y+profile["height"],h)


class TransferTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(self.temp.name)
        self.data = png()
        self.key = digest(self.data)
    def tearDown(self): self.temp.cleanup()

    def upload(self):
        self.store.begin(self.key, len(self.data))
        for offset in range(0, len(self.data), 1000):
            self.store.chunk(self.key, offset, base64.b64encode(self.data[offset:offset+1000]).decode())
        self.store.finish(self.key)

    def test_resume_duplicate_ack_and_activation(self):
        self.store.begin(self.key, len(self.data))
        chunk = base64.b64encode(self.data[:1000]).decode()
        self.assertEqual(self.store.chunk(self.key, 0, chunk)["offset"], 1000)
        self.assertEqual(self.store.chunk(self.key, 0, chunk)["offset"], 1000)
        resumed = Store(self.temp.name)
        self.assertEqual(resumed.begin(self.key, len(self.data))["offset"], 1000)
        for offset in range(1000, len(self.data), 1000):
            resumed.chunk(self.key, offset, base64.b64encode(self.data[offset:offset+1000]).decode())
        resumed.finish(self.key)
        self.assertTrue(resumed.begin(self.key, len(self.data))["complete"])
        manifest = resumed.check(fixture(self.key))
        resumed.commit(manifest)
        self.assertEqual(resumed.load(), manifest)

    def test_corruption_and_missing_images_leave_live_manifest(self):
        self.upload()
        good = self.store.check(fixture(self.key)); self.store.commit(good)
        with self.assertRaises(FileNotFoundError): self.store.check(fixture("a"*64))
        self.assertEqual(self.store.load(), good)
        key = "b"*64
        self.store.begin(key, len(self.data))
        for offset in range(0,len(self.data),1000):
            self.store.chunk(key, offset, base64.b64encode(self.data[offset:offset+1000]).decode())
        with self.assertRaises(ValueError): self.store.finish(key)
        self.assertFalse(self.store.path(key).exists())
        with self.assertRaises(ValueError): self.store.begin("../../outside", 100)
        with self.assertRaises(ValueError): self.store.begin(self.key, -1)

    def test_manifest_integrity_and_foundation_number_round_trip(self):
        manifest = fixture(self.key)
        validate(json.loads(canonical(manifest)))
        manifest["pieces"]["original"]["title"] = "tampered"
        with self.assertRaises(ValueError): validate(manifest)
        self.assertEqual(canonical({"value":1.0}),canonical({"value":1}))


class RenderingTests(unittest.TestCase):
    def test_rotation_is_baked_and_dark_is_exact_inversion(self):
        # Original geometric fixture; no library scores in the source package.
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 200"><path d="M30 40H950 M30 60H950 M30 80H950 M30 100H950 M30 120H950" stroke="black"/><circle cx="300" cy="80" r="12"/><path d="M312 80V15" stroke="black" stroke-width="3"/></svg>'
        score = dict(systems={"s1":dict(svg=svg,width=1000,height=200,first=0,last=3,barlines=[30,250,500,750,950])}, performance=[dict(systemId="s1", first=0,last=3)]*5)
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp); (output/"objects").mkdir()
            profile = profiles()["dual-landscape-standard"]
            rotated = render_variant(score, profile, output)
            straight_profile = dict(profile, pixelRotation=0)
            straight = render_variant(score, straight_profile, output)
            self.assertEqual(rotated["pages"][-1]["end"],20)
            for a,b in zip(rotated["pages"],straight["pages"]):
                light = Image.open(output/"objects"/(a["light"]+".png")).convert("RGB")
                dark = Image.open(output/"objects"/(a["dark"]+".png")).convert("RGB")
                unrotated = Image.open(output/"objects"/(b["light"]+".png")).convert("RGB")
                self.assertEqual(light.size,(1080,1920))
                self.assertIsNone(ImageChops.difference(light,unrotated.transpose(Image.Transpose.ROTATE_270)).getbbox())
                self.assertIsNone(ImageChops.difference(dark,ImageOps.invert(light)).getbbox())
                self.assertIsNotNone(ImageChops.difference(light,Image.new("RGB",light.size,"white")).getbbox())


if __name__ == "__main__": unittest.main()

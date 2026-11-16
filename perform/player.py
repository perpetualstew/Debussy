"""Selection and navigation shared by pedal, phone, and local controls."""
from .model import Pages


class Player:
    def __init__(self, manifest, saved=None):
        self.manifest = manifest
        saved = saved or {}
        self.piece = saved.get("piece")
        if self.piece not in manifest["pieces"]:
            self.piece = next(iter(manifest["pieces"]))
        variants = manifest["pieces"][self.piece]["variants"]
        self.profile = saved.get("profile")
        if self.profile not in variants:
            self.profile = next(iter(variants))
        self.theme = saved.get("theme", "light")
        if self.theme not in ("light", "dark"):
            self.theme = "light"
        self.pages = Pages.at_visit(self.variant["pages"], self.layout["slots"], saved.get("visit", 0))

    @property
    def variant(self):
        return self.manifest["pieces"][self.piece]["variants"][self.profile]

    @property
    def layout(self):
        return self.manifest["profiles"][self.profile]

    @property
    def visit(self):
        return self.variant["pages"][self.pages.reading]["start"]

    def snapshot(self):
        return dict(piece=self.piece, profile=self.profile, theme=self.theme, visit=self.visit,
                    step=self.pages.step, pages=[None if p is None else p+1 for p in self.pages.visible],
                    pageCount=self.pages.count, revision=self.manifest["revision"])

    def command(self, request):
        op = request["op"]
        if op in ("next", "prev", "home", "goto"):
            if op == "goto":
                page = request["page"]
                if type(page) is not int or not 1 <= page <= self.pages.count:
                    raise ValueError("Page is outside this piece")
                self.pages = Pages(self.pages.count, self.pages.slots, page-1)
            elif op == "home":
                self.pages.turn(-self.pages.count)
            else:
                self.pages.turn(1 if op == "next" else -1)
        elif op == "select":
            slug = request.get("piece", self.piece)
            profile = request.get("profile", self.profile)
            theme = request.get("theme", self.theme)
            variants = self.manifest["pieces"][slug]["variants"]
            if profile not in variants or theme not in ("light", "dark"):
                raise ValueError("Requested presentation is not cached")
            visit = self.visit if slug == self.piece else 0
            self.piece, self.profile, self.theme = slug, profile, theme
            self.pages = Pages.at_visit(self.variant["pages"], self.layout["slots"], visit)
        elif op != "status":
            raise ValueError("Unknown player command")
        return self.snapshot()

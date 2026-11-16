"""Linux/Tk presenter: PNG decode, display placement and page selection only."""
import argparse
import copy
import json
import os
from pathlib import Path
import queue
import socket
import socketserver
import threading
import tkinter as tk
from .model import canonical
from .player import Player
from .store import Store

MAX_MESSAGE = 2 * 1024 * 1024


def rpc(path, request):
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(120)
        client.connect(str(path))
        client.sendall(canonical(request) + b"\n")
        with client.makefile("rb") as stream:
            line = stream.readline(MAX_MESSAGE + 1)
        if not line.endswith(b"\n"):
            raise ValueError("Incomplete presenter reply")
        return json.loads(line)


def placements(profile):
    w, h = profile["screenWidth"], profile["screenHeight"]
    arrangement = profile["arrangement"]
    if arrangement == "dual-horizontal":
        return [(0, 0, w, h, [(0, 0, 0)]), (w, 0, w, h, [(1, 0, 0)])]
    if arrangement == "dual-vertical":
        # Physical panel placement is up to the performer. Logical desktop
        # positions remain fixed even when the two panels are stacked.
        return [(0, 0, w, h, [(0, 0, 0)]), (w, 0, w, h, [(1, 0, 0)])]
    if arrangement == "split-horizontal":
        return [(0, 0, w, h, [(0, 0, 0), (1, 0, profile["height"])]), (w, 0, w, h, [])]
    if arrangement == "split-vertical":
        return [(0, 0, w, h, [(0, 0, 0), (1, 0, profile["height"])]), (w, 0, w, h, [])]
    if arrangement == "mirror":
        return [(0, 0, w, h, [(0, 0, 0)]), (w, 0, w, h, [(0, 0, 0)])]
    return [(0, 0, w, h, [(0, 0, 0)]), (w, 0, w, h, [])]


class Presenter:
    def __init__(self, root, store):
        self.root, self.store = root, store
        self.jobs = queue.Queue(maxsize=16)
        self.windows, self.images, self.drawings = [], {}, []
        root.withdraw()
        root.bind_all("<KeyPress>", self.key)
        root.bind_all("<KeyRelease>", self.release_key)
        self.pressed, self.releases = set(), {}
        saved = {}
        try:
            saved = json.loads((store.root / "state.json").read_text())
        except (OSError, ValueError):
            pass
        if (store.root / "manifest.json").exists():
            self.player = Player(store.check(store.load()), saved)
            self.install(self.player)
        else:
            self.player = None
            root.deiconify()
            root.title("Piano Library — waiting for library")
            tk.Label(root, text="Sync a performance library from your iPhone.\nOr import a Mac export before starting.", padx=40, pady=40).pack()
        root.after(20, self.poll)

    def prepare(self, player):
        # Decode both themes for the selected piece/profile before touching the
        # live windows. Page turns and theme changes reuse these PhotoImages.
        images = {}
        pixels = player.layout["width"] * player.layout["height"] * len(player.variant["pages"]) * 2
        if pixels * 4 > 384 * 1024 * 1024:
            raise ValueError("This piece/profile exceeds the 384 MiB image-cache budget; export a smaller set on the Mac")
        for page in player.variant["pages"]:
            for theme in ("light", "dark"):
                key = page[theme]
                images[key] = self.images.get(key) or tk.PhotoImage(master=self.root, file=str(self.store.path(key)))
        return images

    def install(self, player, images=None):
        images = images if images is not None else self.prepare(player)
        new_windows, drawings = [], []
        try:
            for index, (x, y, w, h, slots) in enumerate(placements(player.layout)):
                window = tk.Toplevel(self.root)
                window.withdraw()
                new_windows.append(window)
                window.title(f"Piano Library Perform — {index+1}")
                window.overrideredirect(True)
                window.geometry(f"{w}x{h}+{x}+{y}")
                canvas = tk.Canvas(window, width=w, height=h, highlightthickness=0, bg="black")
                canvas.pack(fill="both", expand=True)
                canvas.bind("<Button-1>", lambda e: self.local("next"))
                canvas.bind("<Button-3>", lambda e: self.local("prev"))
                for slot, sx, sy in slots:
                    item = canvas.create_image(sx, sy, anchor="nw")
                    drawings.append((canvas, item, slot))
        except Exception:
            for window in new_windows:
                window.destroy()
            raise
        old = self.windows
        self.windows, self.images, self.drawings, self.player = new_windows, images, drawings, player
        self.render()
        for window in new_windows:
            window.deiconify()
        for window in old:
            window.destroy()
        self.root.withdraw()
        if new_windows:
            new_windows[0].focus_force()

    def render(self):
        player = self.player
        for canvas, item, slot in self.drawings:
            page = player.pages.visible[slot]
            canvas.configure(bg="black" if player.theme == "dark" else "white")
            key = None if page is None else player.variant["pages"][page][player.theme]
            canvas.itemconfigure(item, image=self.images[key] if key else "")
        temp = self.store.root / "state.pending"
        temp.write_bytes(canonical(player.snapshot()))
        os.replace(temp, self.store.root / "state.json")

    def local(self, op):
        if self.player:
            self.player.command(dict(op=op))
            self.render()

    def key(self, event):
        # Ignore OS key repeat while held; next discrete press is one turn.
        symbol = event.keysym
        if symbol in self.releases:
            self.root.after_cancel(self.releases.pop(symbol))
        if symbol in self.pressed:
            return
        self.pressed.add(symbol)
        if event.keysym in ("Right", "Down", "Next", "space", "Return"):
            self.local("next")
        elif event.keysym in ("Left", "Up", "Prior", "BackSpace"):
            self.local("prev")
        elif event.keysym == "Home":
            self.local("home")
        elif event.keysym in ("Escape", "q"):
            self.root.quit()

    def release_key(self, event):
        symbol = event.keysym
        def release():
            self.pressed.discard(symbol)
            self.releases.pop(symbol, None)
        self.releases[symbol] = self.root.after_idle(release)

    def execute(self, request):
        if request["op"] == "activate":
            manifest = request["manifest"]  # Already checked on the worker.
            saved = self.player.snapshot() if self.player else None
            candidate = Player(manifest, saved)
            images = self.prepare(candidate)
            previous, old_images = self.player, self.images
            try:
                self.install(candidate, images)
                self.store.commit(manifest)
            except Exception:
                if previous:
                    self.install(previous, old_images)
                else:
                    for window in self.windows:
                        window.destroy()
                    self.windows, self.images, self.drawings, self.player = [], {}, [], None
                    self.root.deiconify()
                raise
        elif not self.player:
            if request["op"] == "status":
                return dict(ready=False)
            raise ValueError("No library installed")
        elif request["op"] == "select":
            candidate = copy.copy(self.player)
            candidate.command(request)
            if candidate.profile == self.player.profile and candidate.piece == self.player.piece:
                self.player = candidate
                self.render()
            else:
                self.install(candidate)
        else:
            self.player.command(request)
            if request["op"] != "status":
                self.render()
        return dict(ready=True, **self.player.snapshot())

    def poll(self):
        try:
            request, response = self.jobs.get_nowait()
        except queue.Empty:
            pass
        else:
            try:
                response.put(dict(ok=True, result=self.execute(request)))
            except Exception as error:
                response.put(dict(ok=False, error=str(error)))
        self.root.after(20, self.poll)


class Control(socketserver.UnixStreamServer):
    # Sequential server serializes transfers/activation; GUI/pedal stays live.
    def __init__(self, path, presenter):
        self.presenter = presenter
        super().__init__(str(path), Handler)
        os.chmod(path, 0o600)


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(120)
        try:
            line = self.rfile.readline(MAX_MESSAGE+1)
            if len(line) > MAX_MESSAGE or not line.endswith(b"\n"):
                raise ValueError("Invalid message size")
            request = json.loads(line)
            store = self.server.presenter.store
            op = request["op"]
            if op == "begin":
                result = store.begin(request["hash"], request["size"])
            elif op == "chunk":
                result = store.chunk(request["hash"], request["offset"], request["data"])
            elif op == "finish":
                result = store.finish(request["hash"])
            else:
                if op == "activate":
                    store.check(request["manifest"])
                response = queue.Queue(maxsize=1)
                self.server.presenter.jobs.put((request, response), timeout=2)
                self.wfile.write(canonical(response.get(timeout=120)) + b"\n")
                return
            reply = dict(ok=True, result=result)
        except Exception as error:
            reply = dict(ok=False, error=str(error))
        self.wfile.write(canonical(reply) + b"\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", type=Path, required=True)
    parser.add_argument("--socket", type=Path, default=Path.home()/".cache/piano-perform/control.sock")
    args = parser.parse_args()
    args.socket.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.socket.exists():
        try:
            rpc(args.socket, dict(op="status"))
        except (ConnectionRefusedError, FileNotFoundError):
            args.socket.unlink()
        else:
            raise SystemExit("A presenter is already running")
    root = tk.Tk()
    presenter = Presenter(root, Store(args.library))
    server = Control(args.socket, presenter)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        root.mainloop()
    finally:
        server.shutdown()
        server.server_close()
        args.socket.unlink(missing_ok=True)


if __name__ == "__main__":
    main()

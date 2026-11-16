"""Mac-only authenticated library download/render service, HTTPS or loopback."""
import argparse
import hmac
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import secrets
import ssl
import threading
import time
from .model import HASH, canonical


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resources", type=Path, required=True)
    parser.add_argument("--library", type=Path, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--token-file", type=Path, required=True)
    parser.add_argument("--cert", type=Path)
    parser.add_argument("--key", type=Path)
    parser.add_argument("--no-watch", action="store_true", help="Disable automatic approved-source watching")
    args = parser.parse_args()
    if args.host not in ("127.0.0.1", "::1", "localhost") and not (args.cert and args.key):
        parser.error("Non-loopback listeners require --cert and --key")
    if not args.token_file.exists():
        args.token_file.parent.mkdir(parents=True, exist_ok=True)
        with args.token_file.open("x") as stream:
            args.token_file.chmod(0o600)
            stream.write(secrets.token_urlsafe(32))
    token = args.token_file.read_text().strip()
    if len(token) < 32:
        parser.error("Access token must contain at least 32 characters")
    lock = threading.Lock()
    job = dict(running=False)

    def start_render():
        with lock:
            if job["running"]:
                return False
            job.clear()
            job["running"] = True

        def build():
            from .export import export
            try:
                manifest = export(args.resources, args.library)
                result = dict(running=False, revision=manifest["revision"])
            except Exception as error:
                result = dict(running=False, error=str(error))
            with lock:
                job.clear()
                job.update(result)
        threading.Thread(target=build, daemon=True).start()
        return True

    def watch():
        previous = None
        while True:
            paths = [args.resources/"collection.json", args.resources/"UI/finished-pieces.json"]
            paths += sorted((args.resources/"finished").glob("*.json"))
            try:
                stamp = [(str(p), p.stat().st_mtime_ns, p.stat().st_size) for p in paths]
                if stamp != previous and start_render():
                    previous = stamp
            except OSError:
                pass  # Incomplete source replacement: retry after it settles.
            time.sleep(5)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *values):
            # Do not log bearer tokens, headers or user library paths.
            pass

        def reply(self, code, data, mime="application/json"):
            self.send_response(code)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store" if mime == "application/json" else "private, max-age=31536000, immutable")
            self.end_headers()
            self.wfile.write(data)

        def authorized(self):
            if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                self.reply(401, b'{"error":"Unauthorized"}')
                return False
            return True

        def do_GET(self):
            if not self.authorized():
                return
            if self.path == "/render":
                with lock:
                    status = canonical(job)
                self.reply(200, status)
                return
            if self.path == "/manifest.json":
                path, mime = args.library / "manifest.json", "application/json"
            elif self.path.startswith("/objects/") and self.path.endswith(".png") and HASH.fullmatch(self.path[9:-4]):
                path, mime = args.library / "objects" / self.path[9:], "image/png"
            else:
                self.reply(404, b'{"error":"Not found"}')
                return
            try:
                data = path.read_bytes()
            except FileNotFoundError:
                self.reply(404, b'{"error":"Not exported yet"}')
                return
            self.reply(200, data, mime)

        def do_POST(self):
            if not self.authorized():
                return
            if self.path != "/render":
                self.reply(404, b'{"error":"Not found"}')
                return
            start_render()
            self.reply(202, b'{"running":true}')

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    if args.cert and args.key:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(args.cert, args.key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
    print(f"Home library listening on {args.host}:{server.server_address[1]}. Token file: {args.token_file}", flush=True)
    if not args.no_watch:
        threading.Thread(target=watch, daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()

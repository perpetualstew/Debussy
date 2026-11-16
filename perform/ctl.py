import argparse
import json
from pathlib import Path
from .presenter import rpc

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("request", help='JSON, e.g. {"op":"next"}')
    parser.add_argument("--socket", type=Path, default=Path.home()/".cache/piano-perform/control.sock")
    args = parser.parse_args()
    print(json.dumps(rpc(args.socket, json.loads(args.request)), indent=2))

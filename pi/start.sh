#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
export DISPLAY="${DISPLAY:-:0}"
exec python3 -m perform.presenter --library "${PIANO_LIBRARY:-$HOME/.local/share/piano-perform}"

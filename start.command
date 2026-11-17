#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -x "Debussy.app/Contents/MacOS/Debussy" ]; then ./build.command; fi
open -n "$PWD/Debussy.app"

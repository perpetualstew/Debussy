#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
echo "Building Debussy (macOS 14+)..."
swift build -c release --product Debussy
mkdir -p Debussy.app/Contents/MacOS
cp .build/release/Debussy Debussy.app/Contents/MacOS/Debussy
cat > Debussy.app/Contents/Info.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Debussy</string>
<key>CFBundleIdentifier</key><string>app.debussy.library</string>
<key>CFBundleName</key><string>Debussy</string>
<key>CFBundleDisplayName</key><string>Debussy</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.2</string>
<key>CFBundleVersion</key><string>2</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
codesign --force --sign - Debussy.app >/dev/null 2>&1 || true
echo "Built $(pwd)/Debussy.app"

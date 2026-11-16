# Validation — November 15, 2026

This is a source implementation/development preview. It has not been installed on
the physical Pi or signed/installed on the iPhone in this change.

## Passed locally

- Nine Python tests: alternating turns and reverse; single/odd-page boundaries;
  theme and layout cursor preservation; fixed desktop geometry across orientation
  changes; Mac-baked rotation and exact dark inversion; interrupted transfers and
  duplicate-chunk acknowledgements; checksum/path/missing-object rejection;
  manifest revision integrity across Foundation-style number normalization; an
  authenticated loopback Mac service with a real render request, all sixteen
  profiles and verified output objects.
- iOS 17 arm64 SDK type check with the final controller sources, no diagnostics.
- Xcode iPhone-device build with signing disabled. Xcode 15.3 / iOS 17.4 SDK.
  This is an unsigned development build, not an installable signed release.
- Packaged Mac source builds with SwiftPM and temporary module-cache directories.
  Private resource restoration is required to use the Mac library UI.
- Complete Mac export of the 15 approved pieces across 16 profiles (8 arrangements
  × 2 sizes), with both light and dark PNGs. Repeated profile content is deduplicated
  by hash. The exporter preserves approved finished-system SVGs and explicit
  performance routes; it does not re-engrave or independently certify the notes.
  The export references 1,666 unique PNGs totaling 172,238,221 bytes (164.3 MiB).
- Full private-bundle audit passed: all referenced file hashes and dimensions,
  complete route intervals, all 1,666 PNG decodes, 833 exact light/dark inversions,
  and nonblank score pages. Revision:
  `f5ddc30e1bbe4e24fd6408e54aca95ac0605c73d3c88bc090d56d667bb73be00`.
- Source ZIP audit: every packaged source matches its SHA-256 manifest; no score
  images, PDFs, private-library folders, credentials or Xcode user settings occur
  in the archive. Existing Noto Music glyph licensing is retained.
- Visual inspection of a sample contact sheet showing standard/large portrait,
  landscape, and single-screen split layouts from The Christmas Song. This is
  layout inspection, not a new musical proofreading pass for the entire library.

The private export can be audited again with:

```sh
.venv/bin/python tools/verify_bundle.py bundles/side-trak
```

The largest exported selected-piece/profile cache is 315,187,200 raw image bytes
(about 301 MiB), for I've Got My Love to Keep Me Warm in large landscape. Tk,
compositor overhead, and overlapping old/new caches during a piece switch are
additional. The source export is not evidence of physical Pi memory/latency.

## Still requires actual devices

BlueZ GATT registration/permissions and iPhone bonding/trust; iPhone signed install;
simultaneous HID pedal and BLE controller operation; BLE throughput and disconnect
behavior; physical screen placement, window focus and rotation; measured page-turn
and profile-switch latency; restart/autostart; remote HTTPS/VPN reachability and
trusted certificate setup. See the acceptance sequence in SETUP.md.

The Mac and Pi installed releases were not replaced. No GitHub remote repository
was created or published. The source ZIP excludes all private score assets and
credentials; the rendered PNG bundle stays local and separate.

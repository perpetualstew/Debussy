**Latest requirements:** Read [the iPhone relay handoff](docs/IPHONE-RELAY-HANDOFF.md) first. It supersedes the prototype’s manual sync and retained-version behavior described below.

# Debussy

Piano Library’s Mac, iPhone, and SideTrak performance project.

Mac-owned music library, offline SideTrak performance display, and an iPhone remote.

The Mac owns the scores and renders every presentation. The iPhone stores and
relays the PNG library over Bluetooth, selects a piece/presentation, and provides
backup page-turn buttons. The Raspberry Pi stores PNGs and displays them. It does
not engrave, reflow, invert, resize, rotate, or call home. It works without the
phone or a network after the library is installed.

**Development preview, not yet hardware-qualified.** Python navigation, rendering,
and transfer tests pass locally; see [VALIDATION.md](VALIDATION.md) for the exact
checks. Installation, real Bluetooth transfer speed, pedal behavior, and physical
SideTrak orientation need acceptance testing on the devices. Existing installed
Mac/Pi releases are not replaced by this source package.

## Contents

- `mac-app/`: snapshot of the existing Mac application source. Restore your local
  private resources with `tools/hydrate_mac.py` before running it. Generic UI source
  is in `mac-app/UI`; the live Mac project remains the original `rebuild` folder.
- `perform/export.py`: Mac-only export from approved finished SVGs.
- `perform/home.py`: optional authenticated download/render service on the Mac.
- `perform/presenter.py`: local PNG presenter with alternating page turns.
- `perform/bluetooth.py`: BlueZ BLE bridge to the presenter’s local socket.
- `ios/PianoRemote.xcodeproj`: native iPhone remote, offline cache and resumable sync.
- `tests/`: original geometric fixtures, navigation and interrupted-transfer tests.

Practice presentation is deliberately deferred. The existing Mac Practice tools
remain in the source snapshot; this remote protocol currently serves Perform only.

## Perform layouts

| Presentation | Physical arrangement | Pedal behavior |
|---|---|---|
| Two portrait screens | Left/right | Alternate the two pages |
| Two landscape screens | Top/bottom | Alternate the two pages |
| One landscape screen | Two pages left/right | Alternate the two regions |
| One portrait screen | Two pages top/bottom | Alternate the two regions |
| One portrait or landscape page | One screen, optional second-screen mirror | Advance one page |

Each has **standard/large** notation and **light/dark** PNGs. “Large” fills more of
the available width with approved systems; it does not re-engrave the score. This
initial exporter preserves existing system breaks. Arbitrary continuous zoom or
new measure reflow requires another Mac-side exporter/profile, not Pi processing.

Two-page turns are `1/2 → 3/2 → 3/4 → 5/4 → 5/6`. Previous reverses this sequence.
Turns clamp at the ends of the piece and never select another piece automatically.
The same rule applies to two regions on one panel. Mirror mode displays the same
single page on both panels.

Orientation is baked into the PNGs on the Mac. **The performer rotates/positions
the SideTrak physically.** This release targets the existing fixed desktop setup:
two 1080×1920 logical panels at `(0,0)` and `(1080,0)`. Landscape PNGs are rotated
clockwise in that raster: turn the physical panels counterclockwise from their
portrait position to read them. No runtime display orientation settings change.
Other pixel dimensions or opposite physical rotation need Mac profile changes.

See [SETUP.md](SETUP.md) for installation and [ARCHITECTURE.md](ARCHITECTURE.md) for
cache, synchronization, protocol, position preservation, and home-service behavior.

## Package for GitHub

```sh
python3 tools/package_source.py
```

The output is `dist/Piano-Library-Source.zip`. Extract it into a new folder, then
create a Git repository there. It includes Mac application source, the performance
tools, iPhone project, tests and CI. It excludes private score resources, exported
PNGs, scans, user state, binaries, credentials and historical releases. Do not
upload the original workspace as a whole. No remote repository is created or
published by this command. No new distribution license has been chosen; select
one before inviting reuse, and review [THIRD-PARTY.md](THIRD-PARTY.md).

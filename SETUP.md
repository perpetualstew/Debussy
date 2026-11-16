# Setup and acceptance

This is a new preview directory. Preserve the installed Pi application at
`~/PianoLibrary-Perform-15-Pieces` and its library until this release passes your
device checks. No installation or configuration changes were made to the Pi by
preparing these files.

## Mac: produce the performance library

From this repository, using Python 3.11 or later and a Cairo installation:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-render.txt
.venv/bin/python -m perform.export \
  --resources '/path/to/Piano Library/rebuild/Sources/PianoLibraryMac/Resources' \
  --output bundles/side-trak
```

On the current Mac, `rebuild/tools/export_performance.command` also performs this
export. It reads approved finished SVGs and the finished-piece allowlist. It does
not edit the canonical scores, performance routes or practice data.

The export has sixteen profiles (eight physical arrangements × two sizes), each
with light/dark images. Use repeatable `--piece <slug>` and `--profile <profile-id>`
to export a subset; `--help` lists the supported profiles. Each run replaces the
bundle manifest with the selected subset. Do not run two exporters on the same
output directory concurrently. A full export can take several minutes.

To restore the source-only Mac application snapshot on another Mac:

```sh
python3 tools/hydrate_mac.py --resources '/path/to/your/private/Resources'
swift run --package-path mac-app PianoLibraryMac
```

Private resources include the approved music, source materials, third-party
engraver/fonts and corpus-specific configuration. The snapshot is not a standalone
replacement for those resources. The existing Mac app stays authoritative; changes
made to a separate source snapshot do not automatically flow back to `rebuild`.

## Pi: offline presenter

Copy the repository to a new directory, and copy the exported folder to
`~/.local/share/piano-perform` (USB/SD card is useful for the initial full library).
Alternatively, start with an empty folder and sync from the iPhone. Install OS
dependencies during setup:

```sh
sudo apt-get install python3-tk python3-dbus python3-gi bluez
```

Stop the old presenter, then run these in separate terminals in the **new** source
directory, inside the Pi’s existing graphical login session:

```sh
sh pi/start.sh
python3 -m perform.bluetooth
```

The default library path can be changed using `PIANO_LIBRARY` for `pi/start.sh`.
The presenter uses a private Unix socket at `~/.cache/piano-perform/control.sock`.
The existing desktop must expose two 1080×1920 panels at `(0,0)` and `(1080,0)` with
pixel scale 1, matching the previous Pi handoff. The presenter does not alter
display settings. Single-screen profiles leave the other panel black; mirror
profiles show the same page on both. A disconnected second display is not required
for single-screen operation.

Pair the page-turn pedal as a standard Bluetooth keyboard/HID device. Supported
next keys are Right, Down, PageDown, Space and Enter; previous keys are Left, Up,
PageUp and Backspace. Home returns to the start. Held-key repeat is suppressed.
Pedal profiles that send other keys need a mapping in `Presenter.key` before use.

For the initial phone pairing, open `bluetoothctl`, enable Bluetooth, start an
agent (`agent KeyboardDisplay`, `default-agent`, `pairable on`), and connect using
the iPhone app. The first encrypted command triggers pairing. Confirm the pairing
prompt, then use `devices` and `trust <IPHONE_BLUETOOTH_ADDRESS>` on the Pi. Retry
the app command. Set `pairable off` after setup. Do not confuse the pedal’s address
with the phone’s. The bridge refuses application requests from untrusted devices.
BlueZ permissions and simultaneous pedal/peripheral operation need testing on the
actual Pi OS; do not run the entire GUI as root to work around a permission issue.

Local diagnostics:

```sh
python3 -m perform.ctl '{"op":"status"}'
python3 -m perform.ctl '{"op":"next"}'
python3 -m perform.ctl '{"op":"select","theme":"dark"}'
```

Autostart is not installed by this preview. After acceptance, launch both processes
from the graphical session at boot, keeping the presenter independent of the BLE
bridge. Roll back by closing both new processes and launching the previous Pi app.

## iPhone: native controller

Open `ios/PianoRemote.xcodeproj` in Xcode, select your own signing team and a unique
bundle identifier, select the iPhone, and Run. The deployment target is iOS 17.
Signing/provisioning must use your Apple account; the source package does not
contain a signed installable iPhone app.

1. Import the entire Mac export folder through Files, or configure Home Mac and
   refresh. Keep `manifest.json` beside the `objects` folder.
2. Find Pi, connect, and complete the one-time pairing/trust setup above.
3. Sync library to Pi. Keep the app foregrounded. A disconnected transfer resumes
   on the next sync. Complete activation occurs only after all images are present.
4. Choose piece, layout/size and light/dark, then tap Show on SideTrak.
5. Rotate and position the physical panels to match the chosen layout. For
   landscape profiles, rotate them counterclockwise from the baseline portrait
   orientation. The PNGs already contain the required clockwise rotation.

Previous/Next and Go to page are backup controls. During a bulk sync the phone’s
other controls are disabled; the Pi pedal remains active. Reconnect explicitly
after a Bluetooth disconnect. The phone does not attempt to redraw missing PNGs.

## Optional call-home service

Run on the Mac in the renderer environment:

```sh
.venv/bin/python -m perform.home \
  --resources '/path/to/private/Resources' \
  --library bundles/side-trak \
  --token-file private-library/home-token
```

The default is loopback `127.0.0.1:8766`, intended behind your authenticated network
access/TLS setup. Alternatively supply `--host`, `--cert` and `--key` for direct
TLS. The phone requires an HTTPS URL and a certificate trusted by iOS. Configure
remote reachability separately (for example, your existing private VPN/HTTPS
endpoint); no tunnel, DNS record, firewall opening or cloud account is provisioned
by this project. Enter the service URL and the generated token in the iPhone app.
The token is saved in the phone’s Keychain. Keep the Mac awake for remote renders.
The service automatically rebuilds on startup and watches for approved-source
changes every five seconds. Use `--no-watch` for manual-only rendering. A phone
refresh during rendering receives the previous complete library; refresh again
after the build finishes, or use Ask Mac to rebuild and wait for completion.

## Device acceptance before a gig

- Confirm every profile’s physical panel/region order and rotation. In single-page
  mode verify second-panel black/mirror behavior.
- Check `1/2 → 3/2 → 3/4 → 5/4`, reverse, first/last pages, and an odd final page.
- Switch theme and layout mid-piece, including a repeated/coda passage. The change
  may rewind to the start of the new page but must not skip music.
- Turn with the pedal and phone, disconnect the phone, and keep playing. Restart
  the Pi without Wi-Fi or phone and confirm the saved selection loads.
- Interrupt a file transfer; confirm the displayed music remains available and a
  subsequent sync resumes. Test a bad checksum and a missing image rejection.
- Measure real theme/piece switch latency, memory use and full BLE transfer time.
  Use USB/SD for first provisioning if full-library Bluetooth transfer is too slow.

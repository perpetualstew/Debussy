# Performance architecture

## Responsibilities

```
Mac canonical library -> Mac PNG exporter -> immutable manifest + PNG objects
                                         | HTTPS (phone internet connection)
                                         v
                                iPhone persistent cache
                                         | Bluetooth LE
                                         v
                   Pi persistent cache -> PNG presenter -> SideTrak panels
                                         ^
                                  Bluetooth HID pedal
```

Only the Mac changes score appearance. A phone request to change theme, layout,
size or orientation selects an already-rendered profile. Common variants belong
on **both phone and Pi before a gig**. A tiny selection command then suffices.
If a variant is missing, sync it first. Bulk PNG transfers over BLE are not promised
to be instantaneous. The current implementation syncs the entire exported bundle;
export a smaller chosen repertoire when faster initial provisioning matters.

The Pi’s permitted work is file I/O, SHA-256 integrity checking, JSON selection
metadata, PNG decoding into Tk image buffers, and display/page selection. Neither
phone nor Pi performs any notation or pixel transformation. Logical desktop panel
coordinates are fixed; the performer positions/rotates the hardware.

## Library and updates

`manifest.json` schema 1 identifies the library revision, piece titles, profiles,
page routes and light/dark image hashes. `objects/<sha256>.png` is immutable.
Identical images across single/dual/mirror presentations are stored once. The
Mac exporter writes new images first, then atomically replaces the manifest.
Phone downloads verify hashes before activating their manifest. The Pi receives
resumable object chunks into `incoming/`, verifies each completed PNG, then checks
all references and dimensions before accepting a manifest. The selected piece’s
images are decoded before changing the visible library. A failed transfer leaves
the current library and display usable. Prior objects and the previous manifest
are retained; garbage collection is not automatic in this preview.

Library files and persistent player selection are separate. Page/profile/theme
state is saved locally. The current piece and both themes are decoded into memory;
page turns reuse those buffers. There is a 384 MiB raw-image budget for a selected
piece/profile. Actual process/compositor overhead is additional. Piece/profile
switching decodes images and may pause briefly; no measured latency claim is made.

Each page records a half-open interval of **performed measure visits**, not printed
measure numbers. Repeat/coda visits remain distinguishable. After `1/2 → 3/2`,
the reading anchor is page 2; a profile change finds the page containing that visit.
Repagination can rewind to the start of that page, so no music is skipped. The
presenter cannot infer where within a page the performer is currently reading.

## Bluetooth protocol

The native iOS app uses Core Bluetooth as central; BlueZ on Pi is the peripheral.
Service UUID is `d8aa0001-6921-4f5e-9c21-7069616e6f31`; RX/TX end in `0002`/`0003`.
RX is encrypted write-with-response; TX is encrypted read. BlueZ must report the
iPhone as **Paired and Trusted**. The bridge also permits only one current owner.
It never creates a Wi-Fi listener on the Pi.

Requests are `0x1e` + UTF-8 JSON + newline, fragmented by the negotiated maximum
write length. Each includes a UUID `requestID`. One request is outstanding at a
time. TX returns the next 20 response bytes per acknowledged read, or empty while
processing. The phone reads until newline and checks the request ID. This deliberately
conservative baseline favors correctness over bulk throughput; tune only after
measuring the real iPhone/Pi link. An incomplete request is cleared by the next
start marker. Commands are not automatically retried (avoiding accidental double
turns). Object chunks are offset-checked and idempotent on retry.

Commands: `status`, `next`, `prev`, `home`, `goto` (one-based page), `select`
(`piece`, `profile`, `theme`); `begin` (`hash`, `size`), `chunk` (`hash`, `offset`,
base64 `data`), `finish` (`hash`), `activate` (`manifest`). The bridge forwards these
to a mode-0600 Unix socket; a worker handles file transfers while Tk handles the
pedal and display. The Pi persists its library and has no dependency on this bridge
being connected. Keep the phone app foregrounded during transfers; iOS background
transfer/reconnection scheduling is not implemented.

## Calling home

The optional Mac service offers authenticated `GET /manifest.json`,
`GET /objects/<hash>.png`, and `POST /render` with `GET /render` for job status.
A render request always builds the configured approved library and all default
profiles; remote callers cannot submit code, filesystem paths or score edits.
The existing manifest remains available while rebuilding. A bearer token is kept
in a private Mac file and the iOS Keychain. Non-loopback service binds require TLS.

The Mac service watches approved finished resources and rebuilds on startup and
when they change (disable with `--no-watch`). Run one exporter/service per output
folder. The iPhone checks home on foreground activation when configured and can refresh
manually. It can also ask the Mac to regenerate PNGs. This is not a background
guarantee: the Mac must be awake, running the service and reachable through a
user-configured HTTPS/VPN endpoint. The Pi needs no Wi-Fi. If home is unavailable,
the cached phone/Pi library continues working. Home updates never silently change
the Pi mid-performance; the user explicitly chooses Sync library to Pi.
Home refresh runs separately from Bluetooth controls, so an unreachable Mac does
not disable the phone's page-turn buttons. A Pi sync retains its starting manifest
even if a newer phone library finishes downloading during that transfer.

## Primary API references

- [Apple Core Bluetooth transfer sample](https://developer.apple.com/documentation/corebluetooth/transferring-data-between-bluetooth-low-energy-devices)
- [BlueZ GATT characteristic API](https://github.com/bluez/bluez/blob/master/doc/org.bluez.GattCharacteristic.rst)
- [BlueZ GATT application/service example](https://github.com/bluez/bluez/blob/master/test/example-gatt-server)

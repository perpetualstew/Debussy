# Debussy — Presentation Pilot 02

This is a **new, independent macOS application** for designing sheet-music presentations and generating PNGs. It does not require Sibelius, import the old SideTrak PNG library, or change the existing Piano Library, Piano Remote or Raspberry Pi installations.

## What works in this pilot

- The existing **15-arrangement catalog** is bundled from the supplied November 6 *PianoLibrary-Rebuilt-Handoff.zip*.
- It preserves all **304 source-system MusicXML excerpts**, 15 full MusicXML scores, manifests, and original scanned-system references. `QA/verify_sources.py` verifies MusicXML SHA-256s against a checksum inventory generated from the uploaded handoff.
- Select **Christmas Time Is Here** from the sidebar (it opens by default). The locally bundled Verovio engine engraves 17 systems directly from their MusicXML excerpts, without using an old performance PNG.
- Select **1 or 2 screens**, **portrait or landscape**, **large or small notation**, and optional **mirroring**. Every arrangement/profile combination has separate persistent settings.
- Adjust staff/image scale, systems per screen, margins, minimum spacing, title area, horizontal/vertical offsets, and whether systems are distributed across screen height. The preview is generated with the **same drawing function** used for exported PNGs.
- The whole piece is laid out as navigable preview pages. Debussy warns if any output page is cropped and disables PNG export until the layout fits.
- **Export current profile** writes full-resolution **1080×1920 portrait** or **1920×1080 landscape** PNGs for the selected arrangement, with a manifest and per-file SHA-256 checksums.
- Exporting creates complete, uniquely named revision folders and a `latest.json` pointer after the PNGs are written; incomplete exports do not replace existing completed revisions.

Other pieces are present in the sidebar and use the same renderer, but only *Christmas Time Is Here* was thoroughly exercised in this first pilot.

## Install without disturbing the previous version

The ZIP contains a **versioned project folder** so it can coexist with the previous Debussy v1 build. Download `02-Debussy-Presentation-Pilot.zip` to `~/Downloads` and run:

```bash
cd "/Volumes/Seagate/Projects/Debussy" && unzip -q -o "$HOME/Downloads/02-Debussy-Presentation-Pilot.zip" && cd 02-Debussy-Presentation-Pilot && ./build.command && ./start.command
```

Requires **macOS 14 or later** and Apple's Xcode Command Line Tools / Swift 5.9+. The source has been Swift syntax-parsed, but **native AppKit/WebKit compilation and hardware behavior must be tested on your Mac**; this container is Linux, not macOS.

On subsequent launches, while inside the project folder:

```bash
./start.command
```

If `swift build` reports that developer tools are missing, install Xcode Command Line Tools with `xcode-select --install` and retry. Avoid installing or replacing any files in the older Piano Library directory.

## First-use walkthrough

1. Open Debussy. It should select **Christmas Time Is Here** and show two portrait screens after engraving its 17 source systems.
2. Switch between Portrait and Landscape. Adjust *Staff / music scale* and *Systems per screen*; notice they retain separate values when switching back.
3. Click **Next** to inspect every spread. Toggle **Distribute systems across screen height** to compare even spacing against a tighter top-aligned layout.
4. When the export button is enabled, click **Export current profile**. The completed PNGs will be under `Generated/christmas-time-is-here/<profile>/<revision>/`.
5. Click **Generated PNGs** to open that folder in Finder. Its `manifest.json` records layout settings, page-to-source-system mappings, dimensions, and SHA-256 hashes.
6. Repeat for a second presentation profile, if desired. Only the selected piece and selected profile are exported each time.

All source MusicXML, original scans and manifests remain read-only under `ReferenceMusic/`. Debussy's own layout choices are automatically saved in `DebussyState/layouts.json`. These two folders are separate by design.

## What's intentionally **not** included yet

- **No MusicXML editing, Sibelius workflow, or transcription mode.**
- **No measure-level reflow:** original per-system measure groupings from the November 6 source excerpts are retained. The *systems per screen* control changes page composition, not how many measures are engraved in each system.
- **No guarantee of scan-exact engraving.** The embedded, direct MusicXML renderer is being evaluated against original scans. The uploaded handoff may also predate newer musical corrections; do not treat preliminary new PNGs as automatically approved replacements for the currently working performance library.
- **No phone or Pi synchronization yet.** PNG exports are local Mac outputs. The final production manifest and transmission format will be connected after visual approval.
- Dimensions currently use 1080×1920 and 1920×1080 as design defaults per screen. Verify actual SideTrak physical resolution/mapping before production publication.
- The application renders one preexisting source system at a time and keeps those engraved rasterized system images in memory while editing a piece. It does not render or modify music on the Pi.

## QA performed outside macOS

- All 15 original scores, 304 MusicXML excerpts and source scan references inventoried; source excerpt/full-score SHA-256s matched the uploaded handoff.
- The Verovio engine executed in headless Chromium against the 17 MusicXML excerpts for *Christmas Time Is Here*.
- Browser tests confirmed two portrait canvases at 1080×1920 and two landscape canvases at 1920×1080, with no default overflow.
- The same preview pipeline exported five new PNG pages, verified as actual 1080×1920 PNG data. An independent-profile persistence test passed.
- `node --check UI/studio.js` and `swiftc -frontend -parse Sources/Debussy/main.swift` passed.
- Screenshots and test JSON are in `QA/`. QA Python scripts require Playwright/Pillow and are optional; the app requires none of them.

**Recommended next milestone:** review the new notation against the original scans, then allow visual source-system/page arrangement and automatic generation of every chosen screen profile. After this is accepted, connect a finalized package manifest to the Mac → phone → Pi update pipeline.

# Dependencies and distribution

The source archive contains no score scans, score PNGs, finished score JSONs,
private-library data, user state or bundled third-party binary engines/fonts.
It contains project source and references to these external components:

- Python/Tk and the operating system Tk libraries: installed separately on Pi.
- BlueZ, dbus-python and PyGObject: installed separately using Pi OS packages.
- CairoSVG, Cairo, Pillow and their Python dependencies: Mac rendering only,
  installed separately; their upstream licenses continue to apply.
- Apple SwiftUI, Foundation, Core Bluetooth, CryptoKit and Security: SDK frameworks.
- The existing Mac application expects its private Resources folder. That folder
  includes third-party engraving/font components such as Verovio and Noto Music;
  preserve their license notices when restoring or distributing those resources.
- Generic Mac UI code includes Noto Music glyph contours. Their existing copyright
  attribution and SIL OFL 1.1 license are retained in
  `mac-app/NOTO-MUSIC-GLYPH-LICENSE.txt`.

The generic Mac UI source is copied from the active local rebuild. Its music,
calibration JSON, engine bundle, source scans and saved user state are intentionally
not included. No claim is made that the source-only snapshot is a distributable
binary application without its dependencies.

No new project license has been selected. Publishing a repository and granting
an open-source reuse license are separate decisions. Review the intended license
and any resource redistribution before including assets in a public repository.

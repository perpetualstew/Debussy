**ChatGPT handoff: Piano Library → iPhone relay → SideTrak/Pi appliance**

Prepared November 15, 2026, America/Phoenix. This is the implementation brief for
the next chat. It records the user's latest requirements and the actual starting
point. It does not claim that the hardware installation or automatic relay has
already been completed.

**Start here**

Nick has run the Mac PNG exporter successfully and has reached the point of
verifying the resulting PNGs. For this next phase, accept those PNGs as correct.
Do not restart transcription, musical proofreading, engraving, layout design,
Practice mode development, or Mac-side version-management work.

The immediate objective is to make the Pi/SideTrak a restricted, permanently
provisioned performance appliance and make the iPhone its automatic update relay
and remote control. The Mac is the ultimate source of truth. The Pi is the final
disk-backed display endpoint. The iPhone bridges the two.

Nick reports that the Pi has been cleared down to the required OS and libraries
and is now a blank slate. **That current report supersedes older handoff documents
describing an installed 15-piece player.** Do not assume an old installation,
launcher, IP address, desktop session, process ID or Bluetooth bond still exists.
Inspect the real setup before configuring it.

The user wants a handoff and next steps from verified PNGs. This handoff was
created without modifying the runtime, installing anything on the Pi, signing an
iPhone app, or provisioning an external service.

**The nonnegotiable product behavior**

- Open the SideTrak, power it on, and it boots directly into the music presenter.
- The Pi always has its one current Perform PNG library on its own disk after
  initial provisioning. A phone, Internet connection, Wi-Fi, flash drive, or
  Bluetooth connection is not required to boot and display that library.
- The Bluetooth pedal turns pages directly on the Pi. The phone is not in the
  pedal-input path. If Bluetooth itself is disabled, the cached music remains
  displayable; a Bluetooth pedal naturally cannot send turns until reconnected.
- The paired iPhone chooses pieces and presentation options and can turn pages as
  a backup for the pedal. It also automatically delivers Mac-authorized updates.
- Once a complete replacement PNG arrives from the authorized phone, it becomes
  the current stored PNG automatically. No accept/update prompts, merge choices,
  version picker, backup copy, or manual Sync step belongs on the Pi.
- No mouse or keyboard should need to be attached to the Pi, including for the
  intended setup/recovery workflow. Provision it from the Mac or through phone
  onboarding. Do not turn Pi terminal commands into Nick's maintenance routine.
- No notation rendering, reflow, inversion, rotation, scaling, PDF conversion,
  MusicXML, browser-based score engine, or remote Mac client runs on the Pi.
- The phone likewise does not modify score pixels. It downloads, stores, selects
  and transfers images; the Mac produces every visual variation.
- Keep one current library, no retained generations, no automatic backups, no
  old release directories, and no growing pile of superseded image objects.
- The Pi is not another computer Nick has to administer. Failures should recover
  automatically where possible; any actionable status belongs on the phone.

Ordinary PNG decoding, file writes, transport integrity checks, small indexing
metadata, Bluetooth handling, and showing images are permitted. These are the
minimum mechanics of a digital picture frame, not a second music-processing app.

**Architecture and ownership**

```text
MAC — authoritative library and all PNG generation
  |
  | Phone downloads current PNGs over its network connection
  | Mac may notify the phone that new PNGs are available
  v
iPHONE — persistent local PNG cache, automatic relay, remote control
  |
  | Bluetooth: missing/replacement PNGs + tiny control commands
  v
PI — ONE current PNG library on local disk + minimal presenter/receiver
  |
  v
SIDETRAK — already-rendered music

Bluetooth pedal ---------------------------> Pi page-turn input
```

The Mac determines desired content. The phone carries it. The Pi accepts it and
displays it. The Pi never calls home, resolves competing edits, renders a missing
variant, or invents a substitute image. If the phone cannot reach home, it can
still update the Pi from its already-complete local cache. If the phone is absent,
the Pi continues using the last complete files it received.

The Mac-to-phone leg may use the phone's home Wi-Fi, cellular Internet, or an
appropriate private network route. The phone-to-Pi leg is Bluetooth. Do not
quietly introduce a requirement for Pi Wi-Fi or for both devices to join a hotspot.

**What “exactly one library” means for the implementation**

Use the existing verified PNG set as the initial current library. Its existing
light/dark, size and orientation variants are current assets within that library;
they are not historical versions. Do not create multiple complete installations
or old/new catalog directories on the Pi. Future decisions about which variants
to generate or retain belong to the Mac-side work, which is deferred.

Prefer a straightforward Pi current-file layout, for example:

```text
current-library/
  index.json
  pieces/<piece-id>/<presentation-id>/<theme>/page-0001.png
  ...
```

This is a proposed logical layout, not the existing export format. The current
Mac export uses hash-named files; adapt it without re-rendering the verified PNGs.
The phone can translate the Mac manifest into stable destination names. A hash is
useful to detect unchanged bytes; it does not justify keeping old copies.

The Pi may retain only the small metadata needed to locate current files, map
pieces/pages, maintain the current selection and recognize its paired devices.
An inventory/checksum describing current disk content is not a revision history.
Do not introduce a Git repository, catalog database with historical rows, restore
points, a previous-manifest file, or a backup subsystem on the Pi.

Replacement should have these semantics:

1. The phone announces the destination and the length/checksum of the new file.
2. The Pi receives it automatically, with bounded temporary transfer storage.
3. Once the complete bytes pass transport checks, replace the current file and
   acknowledge only after the replacement is durably stored.
4. Refresh affected decoded display buffers automatically so a stale in-memory
   image does not continue to stand in for the new disk image.
5. The superseded file is not kept. Clear transfer remnants automatically.

“No questions asked” means no human content-approval or conflict-resolution step.
It does not require treating a disconnected half-transfer as a valid PNG, or
accepting commands from an unpaired stranger.

There is an unavoidable implementation distinction: safe atomic replacement may
briefly use a `.part` file or receive buffer while the current file remains intact.
That is temporary transfer machinery, not a second usable library or a backup.
Bound it, clean it automatically, and never describe a full staged library plus
an old library as satisfying this requirement. If “one copy” is interpreted as
forbidding even transient replacement bytes, explain that direct overwriting can
leave the only file corrupt after an interrupted transfer; do not promise both
zero temporary storage and interruption-safe replacement.

For this phase, prove same-logical-page replacement using the accepted PNG set.
Do not smuggle a full multi-generation deployment system back in to handle
hypothetical future repagination. Changing page counts/index structures across
many files needs an explicit coherence policy later. Per-file atomic replacement
does not by itself guarantee an all-or-nothing multi-file library update. Keep
that limitation clear and defer the broader Mac presentation-management design.

For explicit deletions, the phone supplies the authoritative current inventory;
remove no-longer-needed files automatically when the corresponding current index
is consistent. Do not infer a deletion merely because an inventory message or
transfer was interrupted. Obsolete bytes must not accumulate after successful
updates.

**Automatic relay: required event behavior**

The normal workflow must not require a Sync button. A diagnostic “sync now” button
may exist on the phone, but it cannot be the mechanism that makes the system work.

| Event | Required response |
|---|---|
| Pi powers on, phone absent | Start the presenter from local disk immediately; advertise the Bluetooth service without blocking music. |
| Paired phone comes into range | Reconnect automatically; reconcile the Pi's current contents with the phone's current desired contents; relay differences. |
| Phone finishes downloading newer Mac PNGs while connected | Queue and deliver them to the Pi automatically, with no additional approval. |
| Phone downloads while away from the Pi | Persist pending work on the phone; relay when the Pi is next reachable. |
| Mac changes content while phone is unavailable | Keep the latest desired state available on the Mac; reconcile on the next usable phone connection. |
| Mac is asleep/unreachable | Continue with cached phone/Pi files; never block page-turn controls waiting for home. |
| Bluetooth drops mid-transfer | Continue displaying the valid current PNG; retry/resume automatically on reconnection. |
| Pi restarts after a completed replacement | Display the replacement from disk without needing the phone to send it again. |
| A newer replacement supersedes an undelivered phone update | Coalesce to the latest Mac-authorized state rather than replaying every intermediate state. |

Persist pending downloads, pending relay work and retry state on the phone. The
Pi needs only enough transient state to finish/restart the current transfer and
report its actual current contents. Reconnects must reconcile actual files rather
than assume the last acknowledgement arrived. Do not confuse request IDs,
checksums or transfer offsets with a need for Pi-side version management.

Serialize the authorized update stream. An old queued retry must not overwrite
a newer file delivered by the phone. Manage that ordering in the phone's relay
queue, fetching the Mac's latest desired state rather than treating notification
arrival order as authoritative.

Page-turn and selection commands must remain responsive during bulk updates.
Prioritize control traffic between bounded file-transfer chunks. The existing
prototype disables most phone controls during sync; that must change. Keep pedal
handling independent of the transfer path. Do not silently add a policy that
holds all received updates until a later manual performance approval.

**Calling home and being called by the Mac**

The phone needs both reconciliation and a way to learn promptly about changes:

- **Call home:** On usable opportunities—connection to the Pi, app activation,
  a supported background event, network recovery, or a Mac notification—check the
  Mac's current published manifest. Download only missing/changed complete PNGs.
  Keep those PNGs on the phone and automatically relay them when Bluetooth permits.
- **Be called:** After publishing complete PNG updates, the Mac sends an update
  hint to the phone through an appropriate supported notification mechanism. The
  phone then fetches current authoritative content and relays it. A hint is not
  a PNG payload and is not a historical revision to install blindly.
- **Active session:** A phone-initiated event subscription can make updates prompt
  while the app is running. It is not a substitute for iOS background support.
- **Background notification:** Evaluate Apple Push Notification service (APNs).
  The Mac can act as the authenticated provider; an optional small relay could
  handle signaling if needed. Neither may become a renderer or a new source of
  truth. The content endpoint still has to be reachable by the phone.

Do not describe the Mac as making an arbitrary incoming socket call into a sleeping
iPhone. Plan authentication, device registration, notification credentials,
network reachability and trusted TLS explicitly. Keep these concerns off the Pi.
Group bursts of Mac edits into a completed publication and a coalesced update hint.

Apple explicitly says background push delivery may be delayed or throttled and
is not guaranteed. Treat push as a useful trigger; reconciliation and persistent
pending work must recover missed hints. The current prototype has no APNs sender
or receiver. [Apple: Pushing background updates to your app](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app).

**iPhone background behavior is a required engineering milestone**

The requested experience is automatic relay when the phone is nearby, including
ordinary locked/background use. Do not quietly substitute “open the app and tap
Sync” as the finished design. Also do not promise immediate unattended delivery
merely because Bluetooth pairing exists.

Implement supported Bluetooth background operation, a persistent restoration
identifier, restoration callbacks, remembered peripheral identity, and pending
reconnection. Use Core Bluetooth events and a persisted transfer state machine;
the current foreground timer/read-polling implementation cannot be assumed to run
indefinitely while suspended. Apple documents background event handling and state
preservation/restoration, not unlimited execution. [Apple: Core Bluetooth background processing](https://developer.apple.com/library/archive/documentation/NetworkingInternetWeb/Conceptual/CoreBluetooth_concepts/CoreBluetoothBackgroundProcessingForIOSApps/PerformingTasksWhileYourAppIsInTheBackground.html).

Check Nick's actual iPhone/iOS version and the available Xcode/SDK before choosing
the accessory-onboarding approach. Apple's current TN3115 includes iOS 26 rules
where AccessorySetupKit affects restoration eligibility after certain user
actions, including force quit and Control Center Bluetooth changes. Restoration
also depends on pending Bluetooth work/events; first unlock after restart matters.
Do not repeat a blanket claim that every force-quit app always can—or never can—
relaunch. Evaluate AccessorySetupKit for this Pi accessory and verify on hardware.
[Apple: TN3115, Bluetooth state restoration app relaunch rules](https://developer.apple.com/documentation/technotes/tn3115-bluetooth-state-restoration-app-relaunch-rules).

Implement durable background-capable network transfers where appropriate and
separate them from the Bluetooth send queue. Finishing a network download does
not automatically grant unlimited time for a large BLE upload. Save progress and
continue at subsequent permitted execution opportunities.

If a tested iOS state prevents fully automatic progress, report that precise
limitation and the smallest phone-side recovery action. Do not hide it behind a
claim of “set and forget,” or work around it by requiring Pi Internet/keyboard
access. The Pi must remain immediately playable regardless.

Use an iPhone installation/signing arrangement appropriate for ongoing use.
Do not deliver an installation that silently stops working when temporary
development provisioning expires and call that a maintenance-free appliance.
Resolve the available signing/distribution route as part of setup.

**Fixed display and page-turn behavior to preserve**

Orientation is already baked into the PNGs by the Mac. The phone selects the
appropriate presentation; Nick physically rotates or positions the SideTrak.
The Pi does not rotate pixels or change OS display orientation when switching
presentation. Establish one correct physical-pixel desktop mapping during setup.

Existing profiles cover two portrait panels left/right; two landscape panels
top/bottom; two independent page regions on one landscape or portrait panel; and
one page on one panel with an optional mirror on the other panel. Preserve the
already-exported variants rather than redesigning these arrangements now.

Two-page navigation is **1/2 → 3/2 → 3/4 → 5/4 → 5/6**, replacing the page just
read while keeping the page being read. Previous reverses that progression.
The same rule applies to two regions on one screen. Single-page/mirror mode
advances one page; a mirror is not an independently advancing second page.

Preserve the existing route-visit metadata when selecting presentations so
repeated visits to a printed measure remain distinguishable. Phone and pedal
must drive the same navigation state, clamp at the ends, and never unexpectedly
select the next piece. Do not reset the current piece/page on every reconnect or
ordinary PNG replacement.

**Existing local files and implementation status**

Workspace:
`/Volumes/Seagate/Projects/Piano Library`

| Location | Meaning |
|---|---|
| `rebuild/` | Active Mac library project; remains the authority. |
| `rebuild/tools/export_performance.command` | Export command Nick ran successfully. |
| `performance/bundles/side-trak/manifest.json` | Current local export's piece/page/profile mapping. |
| `performance/bundles/side-trak/objects/` | Exported PNGs with content-hash filenames. |
| `performance/perform/export.py` | Mac-only renderer; leave the accepted PNG appearance alone for this phase. |
| `performance/perform/home.py` | Mac watcher and authenticated HTTP download/render endpoints. |
| `performance/perform/model.py`, `player.py` | Manifest helpers and alternating page navigation. |
| `performance/perform/store.py` | Prototype receiving/storage logic; must change to satisfy one-current-library semantics. |
| `performance/perform/presenter.py` | Tk PNG viewer and local control socket; needs appliance startup/input hardening. |
| `performance/perform/bluetooth.py` | Prototype BlueZ GATT bridge; not hardware-qualified yet. |
| `performance/pi/start.sh` | Starts the viewer only; not a complete boot installation. |
| `performance/ios/PianoRemote.xcodeproj` | Native iPhone app project. |
| `performance/ios/PianoRemote/Library.swift` | Phone cache, home downloads and manual relay implementation. |
| `performance/ios/PianoRemote/BluetoothController.swift` | Foreground connection/transfer implementation. |
| `performance/ios/PianoRemote/PianoRemoteApp.swift` | Current phone interface and manual sync controls. |
| `performance/VALIDATION.md` | Prior local build/test report; not device acceptance. |
| `performance/dist/Piano-Library-Source.zip` | Prior source-only GitHub package; not a Pi deployment image. |

The prior local report recorded 15 pieces, 16 presentation profiles, and 1,666
unique PNGs, about 164.3 MiB of referenced image data. Nick has subsequently run
the exporter himself. Inspect the current manifest for actual transfer sizing;
do not rerender merely to recreate the old report. Initial Bluetooth provisioning
may take appreciable time. Measure it; do not promise an instant full-library
transfer. Routine changes should transfer only the changed files.

Prior work passed Python tests and unsigned iPhone/Mac source builds. It did not
prove physical Bluetooth transfer, background iOS relay, Pi autostart, sustained
pedal operation, or no-keyboard recovery. The largest measured raw image cache
was about 301 MiB before GUI/compositor and transition overhead. Inspect actual
Pi RAM before retaining the prototype's preload strategy.

Specific incompatibilities to fix:

| Prototype behavior | Required change |
|---|---|
| `store.py` writes `manifest.previous.json` and keeps old hash-addressed images. | No previous manifest or old asset generations. Replace current content; remove obsolete files automatically. |
| Phone sync requires a button; completed home downloads do not initiate relay. | Automatic queue on connection, download completion and retry opportunities. |
| Phone forgets reconnect work and says to reconnect manually. | Remember the provisioned Pi, reconnect and reconcile automatically. |
| No `bluetooth-central` background mode or restoration implementation. | Supported background/restoration path, proven on the actual phone. |
| Mac service only offers request/response endpoints. | Add update signaling; do not claim existing watcher changes can wake the phone. |
| Pi setup requires terminals and `bluetoothctl`; only viewer launch script exists. | Mac/phone-driven provisioning, persistent bonds, supervised boot services. |
| Viewer relies on GUI keyboard focus and allows Escape/Q to quit. | Reliable pedal capture and an appliance session that cannot be accidentally dismissed. |
| Phone controls are disabled during manual bulk sync. | Prioritize page controls while automatic updates proceed. |

Older `performance/SETUP.md`, `ARCHITECTURE.md`, and `Piano-Library-Pi-Handoff.md`
are implementation references, not authority over these newer requirements.
Instructions there to preserve old Pi releases, manually sync, or operate Pi
terminals are superseded. The prior ZIP also predates this handoff.

**Next steps, in order**

1. **Establish the actual device baseline from the Mac.** Determine Pi model/RAM,
   OS version, graphics session, display mapping, Bluetooth adapter capability,
   storage and pedal keycodes. Determine iPhone/iOS and signing tools. Reuse facts
   from accessible state; ask only for genuinely unavailable essentials. Do not
   ask Nick to attach Pi input peripherals or repeat score verification.

2. **Prepare a minimal Pi deployment, not a repository copy.** Include only the
   required runtime modules/libraries, presenter, Bluetooth receiver, device
   configuration, small current index and one current PNG library. Exclude the
   Mac renderer, CairoSVG/Pillow unless independently necessary for a proven
   runtime need, iPhone sources, tests, archives, Git data and old releases. No
   practice engine, web application, PDF/score files or cloud client belongs here.
   Install via Mac-controlled provisioning or an SD image; removable media must
   not be a runtime dependency. Existing unknown files should not be broadly
   deleted under the assumption that an old cleanup report is still accurate.

3. **Implement current-file storage before enabling automatic sync.** Remove
   history retention, adapt the hash-named export to a single current inventory,
   define complete-file acknowledgement and automatic temporary-file cleanup,
   and ensure replacements update both disk and display buffers. Test repeated
   replacement of a logical page without growing obsolete storage.

4. **Make boot and input autonomous.** Install appropriate supervised services
   for the actual Pi OS/session. Start music from local disk without network,
   phone, pairing or update checks as prerequisites. Start Bluetooth independently;
   restart a failed receiver without stopping the score. Start/restart the GUI
   correctly with the actual display environment. Disable screen blanking,
   lock screens, focus-stealing desktop behavior and avoidable quit paths.
   Keep diagnostics bounded/rotated so logs do not become another storage leak.
   Restore the last usable selection, or a deterministic first piece on first boot.

5. **Provision persistent Bluetooth relationships without Pi peripherals.**
   Pair the pedal and phone once using a Mac-controlled setup or phone onboarding
   and an appropriate BlueZ agent. Phone-side confirmation or a code displayed
   on the SideTrak is compatible with this requirement; typing into a Pi terminal
   is not the intended workflow. Persist trust, stop accepting arbitrary new
   controllers after enrollment, and define phone/Mac-led recovery for replaced
   devices. Prove pedal HID and phone BLE work simultaneously and reconnect after
   power cycles. Do not require “Find Pi” for everyday use.

6. **Prove the real hardware transport, then automate it.** Install/sign the native
   phone app, seed its cache with the accepted PNG bundle, and measure actual BLE
   transfer. The current 20-byte reply-read protocol is a conservative prototype;
   measure and improve its flow control/throughput as necessary without adding
   score processing to Pi. Implement a persisted relay queue, retries, state
   reconciliation and control-message priority. A manual first diagnostic send is
   a development test, not the final workflow.

7. **Implement and test locked/background iPhone relay.** Add the supported
   background modes, restoration/reconnection and accessory setup appropriate
   to the actual OS. Test screen lock, app switching, memory termination, restart,
   Bluetooth toggles and force quit separately. Do not equate a foreground demo
   with completion of the requested nearby-phone behavior.

8. **Connect the Mac update channel.** First serve the already-verified PNGs;
   there is no need to request another render. Configure authenticated reachable
   HTTPS for the phone, add current-content reconciliation, and implement Mac
   update hints for foreground and supported background operation. Automatically
   relay completed downloads. Keep the renderer/manifest design extensible but
   defer elaborate Mac version control and presentation-management work.

9. **Perform appliance acceptance and deliver the exact setup.** Exercise the
   checklist below on the actual SideTrak/Pi/iPhone/pedal. Document installed
   services, current data location, pairing recovery and genuine iOS limits.
   Keep service/source provenance and detailed maintenance notes on the Mac.
   There should be no routine Pi maintenance checklist for Nick.

**Acceptance checklist**

- Power on with phone absent, Pi network disabled, and no removable storage.
  Music appears from local disk without a login, terminal, mouse or keyboard.
- Use the pedal through complete even/odd-page pieces and both directions; let
  the screen sit idle, then continue. No lost focus, blanking or unwanted exit.
- Bring the provisioned phone into range. It reconnects and reconciles without
  tapping Find/Connect/Sync. Repeat with the phone normally locked/backgrounded.
- Automatically transfer one replacement page from the phone; no prompt appears
  on Pi. Verify the new pixels display and survive a phone-free Pi restart.
- Publish a harmless test update on the Mac. The phone learns about it, downloads
  it and relays it automatically. Repeat while the phone was initially away from
  the Pi, and while the Mac was temporarily unreachable.
- Interrupt transfer before completion and reconnect. The old current page stays
  usable until a complete replacement exists; the transfer resumes/restarts
  automatically. Test restart around the commit boundary without losing both files.
- Replace the same page repeatedly and inspect disk contents. Exactly one current
  destination remains; no previous manifests, archived PNGs, old releases, or
  unbounded partial files accumulate. Reboot cleanup must require no intervention.
- Make a newer Mac update overtake an unsent older update. The latest desired
  content wins; a stale queued retry does not undo it.
- Turn pages with both phone and pedal during file transfer. Controls remain
  responsive. Disconnect the phone and continue performing with the pedal.
- Verify physical orientation, screen order, single-page mirroring and independent
  half-screen turns without Pi pixel transformation or OS rotation changes.
- Exercise missing/corrupt transfer data and full storage. Report problems on the
  phone, keep current usable content, clean temporary data and retry automatically
  when possible. Do not demand a keyboard to clear a dialog on Pi.
- Test the real iOS background/relaunch cases and record actual timing. Distinguish
  automatic behavior that passed from states requiring phone-side recovery.

**Instruction to the receiving ChatGPT**

Continue from verified, correct PNGs. Build and prove the restricted boot-ready
Pi appliance and automatic iPhone relay. The goal is a digital picture frame with
Bluetooth inputs and replaceable current files—not a second library-management
system. Keep intelligence, pending work and future management on the Mac/phone.
Do not add backups or version history to the Pi in the name of robustness. Be
precise about minimal temporary transfer storage and iOS execution limits. Do not
declare the work finished because source code compiles or a foreground manual
transfer succeeds. Completion means the real hardware meets the accepted
power-on, offline, automatic-update and no-Pi-peripherals behavior above.

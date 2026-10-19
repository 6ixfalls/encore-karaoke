# Server-hosted implementation status

Implementation: October 19, 2026. This checkout replaces the Electron entrypoint and packaging workflow with a standalone Node/Express/Socket.IO server. `npm run build` type-checks and compiles the TypeScript server and shared contracts, then builds the hosted frontend; `npm start` runs the headless service. The original renderer modules remain available as reference for later playback work, but are neither built nor served. The [architecture draft](server-hosted-overhaul-draft.md) remains the broader delivery plan; this document records the implemented hosted features and outstanding gates rather than declaring the entire roadmap complete.

## Implemented

| Area | Available behavior |
| --- | --- |
| Server and build | Strict TypeScript server compiled to `dist/server`; no Electron/native runtime dependency; Node 24 container target; three production packages; independent browser build with local scripts/fonts/icons/QR generation; default build/start and CI use the headless path |
| Authentication | Provisioned admin and host credentials; durable revocable device sessions; Secure/HttpOnly/SameSite cookies; exact Origin and CSRF checks; persistent authentication epochs; role/capability checks on HTTP and Socket.IO |
| Rooms | Room creation, lock/end, expiring and rotatable guest QR/manual invitation exchange, single-use display pairing, device revocation, snapshots/reconnect, credential-based host ownership, multiple rooms with isolated authority |
| Queue | SQLite serialization and transactions; configurable guest/room reservation caps; rolling device/room enqueue limits including failed submissions and hosts; persistent device/server budgets for all fresh commands; 24-hour accepted-command deduplication across restarts, one-minute rejection retention, no retry record for over-budget requests; expected revisions; original cached retry results; explicit overload errors without automatic retries |
| Playback state | Desired versus observed state; unique playback IDs; display-only telemetry; reservation remains until `playing` confirmation; duplicate/stale ends rejected; paused restart/recovery; host play/pause/skip/reorder/seek/volume/tempo controls |
| Display fencing | Deployment-scoped generations; durable grants/deadlines; monotonic server expiry; conservative round-trip-based browser lease budgets; initially closed output gate and scheduled gain cutoff; disconnect pause; suspension retirement; cooperative stopped-output release; acknowledgment-only takeover and audited admin physical retirement |
| Media | Server-owned audio/video/MIDI/KAR/LRC/CD+G index with stable opaque IDs and relative references; no general filesystem API; symlink/canonical-path checks repeated on open; authenticated bounded transfers; content types, byte ranges, ETags, last-modified; paginated library search |
| Browser UI | Combined display/host/EnMoku controller frontend; responsive songbook/queue/room controls; LRC from the display media clock; all untrusted strings rendered as text; validated same-origin dynamic invitation URLs; restrictive CSP |
| Persistence and recovery | SQLite WAL with full synchronous durability; kernel-backed singleton lock; consistent verified backup with settings/schema/checksum; atomic restore with new auth epoch, new deployment epoch at boot, fresh login/pairing/invitations, paused queues, and mandatory all-outstanding-display physical recovery |
| Migrations | Transactional schema initialization and version-1 to version-2 indexes; verified pre-upgrade backup; refusal of unknown future schema; older-version rollback can archive newer target data before restore |
| Deployment | Non-root Dockerfile; Compose resource/process bounds and read-only library; Caddy internal TLS example; operator instructions for DNS, trust, renewal, quotas, backups/rollback, and lost-display retirement |

Local media, rendered MIDI and native live-separated YouTube video share one Web Audio output gate. Release, disconnect and expiry stop native playback. Key login is removed; public launches issue independent owner sessions. Display microphones feed analysis and recording destinations only, never speakers. Deadlines are an additional output precaution; **deadline-based takeover is not enabled or claimed**. Takeover always needs a stopped-output acknowledgment or an administrator’s physical-retirement confirmation. Restore additionally requires isolation of every possibly outstanding display, including grants newer than the backup. This remains mandatory even if a recorded old generation acknowledges release.

## Verification performed

- Clean dependency installation, browser build, and ESLint.
- State, HTTP, Socket.IO, recovery, schema, and simulated browser-player tests under `tests/server/`.
- Three simultaneous Socket.IO controllers: snapshots, queue insertion, retry after reconnect, concurrent room-cap overflow, denied controls, and session revocation.
- Authenticated byte ranges and validators, missing credentials, cross-room access, foreign Origin, wrong CSRF, traversal, symlink escape, and registered-target replacement.
- State-machine coverage for confirmation/duplicate end events, reservation/rate admission, restart deduplication, wall-clock changes, generation fencing, physical retirement, restored authentication invalidation, and grants newer than snapshots.
- Recovery tests for corrupt checksums, active-process exclusion, schema upgrade, SQL failure/rollback, process kill before commit, compatible restore from an unsupported future schema, and original snapshot preservation.
- Simulated player tests for closed routing, cutoff preservation during volume changes, delayed lookup/renewal races, disconnect, permanent retirement, stopped audio clock, and release retry. These test control logic, **not physical audible output**.
- An actual local Chromium-based in-app browser loaded the hosted frontend, signed in, created a room, indexed/queued/played an MP3 fixture, advanced LRC text against media time, displayed an HTML/event-handler lyric payload literally, and returned to idle on track completion. The fixture was a temporary silent MP3 encoded locally for testing; it is not distributed as a song/library asset.

No physical latency measurements, low-end profiling, trusted-LAN phone tests, or Docker runtime validation have been performed. The local Docker daemon was unavailable. CI contains a container build check, but adding that check is not evidence that it has run.

## Outstanding roadmap and release gates

| Phase | Remaining work / evidence |
| --- | --- |
| 0 | Phone-to-display microphone feasibility spike on real target hardware; trusted custom-domain HTTPS capture; repeatable mouth-to-speaker delay measurements and device matrix |
| 1 | Execute the supplied container/TLS/DNS setup on a real installation; fresh phone/display profiles and no WAN; verify every required asset and browser API in that environment |
| 2 | Actual TV plus at least three phones, QR/manual pairing through trusted custom DNS, fresh-cache/no-WAN flow, real main-thread stalls and browser/OS suspension including stopped audio clocks, physical speaker cutoff and cooperative release, crashed-display retirement, backup/restore and failed-upgrade drills on container volumes; full multi-role injection matrix; low-end resource profiling |
| 3 | MIDI/SoundFont and reference melody, CD+G, multiplex pan, video/container/codec probing, bounded FFmpeg compatibility jobs/cache, key shifting, representative playback/seek/timing fixtures |
| 4 | Remote microphone grants and generation-scoped signaling; receive-side revocation/emergency mute; one/two independent singer audio graphs; capture presets, calibration, scoring/score-only fallback, STUN/TURN provisioning, Android/iOS foreground/background and Wi-Fi-loss checks; hardware latency/feedback evidence before amplified vocals |
| 5 | Expanded recovery and device matrix; server recording storage/integrations; retention/quotas; full release operational hardening |

Phone microphones and signaling are rejected explicitly. No automatic microphone permission request is made. Chat, camera sharing, Discord/OBS/native system volume, library metadata import previews, optional host-approval joins, administrator user management, server conversion, and full desktop synthesizer/format parity remain unimplemented. Shared cheers, YouTube, display scoring, recording and expanded browser formats are implemented as described in [hosted media features](hosted-media.md). File naming currently provides artist/title; existing manifests and `songdb.json` are not imported. Scanning is bounded to one job, but large-library indexing and search still need low-end profiling and background-worker refinement before the larger format library rollout.

Operator secrets are provisioned outside backups. A credential rotation changes that host identity; use an administrator to recover/reassign rooms rather than treating old browser sessions as proof of identity. The service does not yet provide multi-user account/password management. General host configuration is never exposed to guests.

### Hosted media validation added October 19

Automated coverage now includes YouTube reservation admission and deduplication, score telemetry validation/fencing, bounded expiring cheers, expanded library indexing and case-insensitive companion matching, MIDI tempo/running status/lyric parsing, CD+G palette/tile rendering and backward seeking, pitch detection and guide comparison, native YouTube routing, microphone-permission cancellation, and recorder export/graph cleanup. Real microphone fidelity, long recordings, YouTube extraction availability and native video autoplay restrictions, browser codec combinations, and physical output retirement remain device acceptance gates.

A local in-app Chromium browser additionally verified WAV/LRC playback, a KAR fixture synthesized to browser audio with embedded lyrics, CD+G companion playback, MP4 playback, room cheers, YouTube URL queueing and actual official iframe playback, pause, seek/resume, and iframe removal on display release. Fixtures and the server were temporary. The YouTube check used Google's public iframe API sample video; it does not establish availability of arbitrary videos or keyword search quota. Actual microphone permission/capture and recordings on physical hardware were not exercised by this browser check.

## Public room appliance update

The dashboard now has only Launch karaoke (`/tv`) and Control (`/control`). Launch creates a room and a unique anonymous owner without credentials. Room codes remain stable for the room lifetime; QR links pair the controller automatically. End room creates a clean boundary between groups. Public rooms expire after 24 hours without an active TV renewing them. The browser exposes no administrator panel; administrator credentials are optional and limited to operator APIs. The TV uses the desktop presentation styles, with a separate room controller and WebRTC phone microphone transport. Build/lint/integration verification does not establish pixel-for-pixel parity with every native desktop screen or validate physical phone audio latency.

The current YouTube path uses yt-dlp extraction and buffered incremental separation with the maintained adefossez/demucs fork. The active display receives a sequential fragmented MP4 containing original video and the separated instrumental; streamed vocal frames supply scoring references. Earlier official-iframe browser acceptance describes the previous implementation. Hardware microphone and online YouTube availability remain acceptance gates.

Nightingale scoring now replaces reference-backed sample-count scoring. The GPL
port uses Pitchy, elapsed-time credit and singable-duration normalization, with
MIDI/vocal-WAV references, input-delay adjustment and replay protection. See
[hosted scoring behavior](hosted-media.md) for preparation limits and the
remaining automatic-reference/per-phone scoring scope. The build ships notices,
the license and corresponding source with the browser application.

Live separation was smoke-tested with the maintained htdemucs model on the
repository's supplied audio fixture: an 18-second H.264/AAC output began in about
6.5 seconds and completed processing in about 14.2 seconds on the development
machine. This validates incremental processing and muxing for that fixture, not
a sustained real-time performance guarantee or vocal-quality assessment. Automated
coverage includes packet continuity, bounded input lookahead, EOF handling,
subprocess cleanup, stale-display cancellation and room/display authorization.

An additional end-to-end online smoke test used the public 19-second YouTube
video `jNQXAC9IVRw`: yt-dlp extracted adaptive streams, the maintained Demucs
worker generated instrumental audio and about four seconds of voiced pitch
reference, and the resulting H.264/AAC stream began at about 6.6 seconds and
finished processing at about 12.5 seconds. FFprobe verified both output streams.
These are single development-machine measurements, not a performance guarantee.

# Hosted media and performance features

The hosted display now plays local media and YouTube, shows room cheers, scores display microphone input, and records performances locally. These use the existing server-owned queue, room authorization, revision ordering, command deduplication, admission limits, and display generations.

## Song formats

Restart the server to rescan the mounted library after adding files. File names supply artist/title (`Artist - Song.ext`). Companion lookup is case-insensitive within the same directory.

| Files | Hosted behavior |
| --- | --- |
| MP3, WAV, OGG, FLAC, M4A, AAC, OPUS | Native browser audio playback through the display output gate |
| MP4, WebM, MKV, MOV | Native browser video and audio through the same gate; actual codec support varies by browser |
| MID, MIDI, KAR | Standard MIDI type 0/1, tempo changes, running status, note timing, text/lyric events; rendered locally to WAV with a portable oscillator synthesizer |
| Same-stem LRC | Timed literal lyrics, including offsets and repeated timestamps |
| Same-stem CDG | CD+G graphics synchronized to media time, including palettes, tiles/XOR, presets, scrolling and transparency; seek rebuilds from the start |
| Same-stem MID beside audio/video | Pitch guide for scoring; also appears as a standalone MIDI song |
| `Artist - Song.vocals.wav` beside `Artist - Song.mp3`/video | Prepared vocal reference for Nightingale scoring; hidden from the songbook |
| `<videoId>.vocals.wav` anywhere in the library | Prepared reference for that exact, case-sensitive YouTube video ID; hidden from the songbook |

MIDI rendering is limited to 4 MiB, 200,000 events, 30,000 notes and 20 minutes. CD+G companions are limited to 32 MiB and LRC to 2 MiB. Local synthesis uses simple waveforms with program families and short percussion tones. It does not reproduce the desktop GM soundfont, sustain/controllers, pitch bend or SysEx effects. MIDI SMPTE timing and type 2 files are rejected. AVI and proprietary formats, archives, `.cho`, manifests, metadata import and server transcoding remain future work. Unplayable native codecs report playback failure and leave the reservation available for an explicit retry or skip.

## YouTube

Paste a supported YouTube URL or 11-character ID in the Songbook, optionally enter a title, and select **Find / queue video**. Guests can queue within their existing reservation limits. Video IDs are validated; the server never fetches user-supplied URLs.

Set `INVIDIOUS_URL` to the base origin of an Invidious instance you operate or trust, for example `https://invidious.example.com`, then restart. No YouTube API key is required. The instance must expose `/api/v1/search`, `/api/v1/videos/:id`, and `/latest_version` with proxying enabled. See the [Invidious API](https://docs.invidious.io/api/) and [proxy parameters](https://docs.invidious.io/url-parameters/). An existing instance is required; this application does not install Invidious. Without configuration, local playback works and YouTube requests return `invidious_not_configured`.

Search is room-authorized, throttled and time-limited. Playback selects a combined MP4 audio/video format (preferring itag 18) and requests `/latest_version?local=true` from the configured instance. Encore proxies the resulting stream, preserves byte ranges for seeking, and cancels upstream work when the display disconnects. Only redirects to the configured instance or HTTPS Google video hosts are accepted. If your instance uses a separate companion origin, expose its stream routes under the configured origin with a reverse proxy. No cookies or room credentials are sent upstream. The proxy shares the local-media transfer limit. No public fallback instance is chosen automatically.

The native video element routes audio through the existing Web Audio gate. Pause, seek, tempo, scoring and recording use the same pipeline as local video. Track changes, release, expiry and disconnect stop output. Availability depends on the instance, YouTube access and browser codecs; videos without a combined MP4 stream fail explicitly. Adaptive-only streams and server muxing are not implemented. Direct streaming does not supply a vocal melody guide: YouTube tracks use pitch-stability scoring unless a matching prepared vocal reference is provided.

## Cheers and scores

Any room guest or host can submit a literal cheer of up to 120 characters. Cheers are shared via authorized room snapshots, deduplicated by command ID, expire after eight seconds, and are capped at twelve recent messages. Existing command rate limits apply. Cheers do not require playback-control permission.

On the active display, choose **Enable microphone & scoring**. Capture requires a secure origin (or localhost) and explicit browser permission. Input is analyzed and optionally recorded locally; it is never amplified or sent to the server. Disable, disconnect, page hiding or display release stops microphone tracks. A late permission response cannot reactivate a retired display.

Encore now ports Nightingale's GPL-3.0 pitch detector adapters and scorer, using Pitchy for microphone/reference detection. Detected pitch is compared in semitones with octave differences accepted; similarity decreases linearly to zero at six semitones. Earned credit is weighted by elapsed media time and divided by the reference's total singable duration. Nightingale's 0–1000 result is displayed and shared as 0–100 (one decimal place). An update earns at most 100 ms of credit. A missed vocal section reduces the final score; an instrumental gap does not earn credit. The displayed value grows toward the final whole-song score, rather than showing accuracy only for the moments already sung. Seeking forward earns no skipped time, and replaying a previously visited region cannot add credit again. These are casual performance metrics, not a calibrated vocal assessment.

Existing MIDI guides work immediately. Overlapping notes count once toward singable duration; for MIDI songs, all non-percussion notes are possible targets, so a dedicated monophonic vocal guide is preferable. A prepared `.vocals.wav` reference takes precedence over MIDI. References must be at most 32 MiB, ten minutes and two channels. They should contain isolated original vocals synchronized exactly to the backing track/video, including any intro silence. Instrumental karaoke audio cannot supply a reliable vocal melody. For YouTube, save a reference as `<videoId>.vocals.wav` and restart to scan it; video IDs are case-sensitive. Local reference companion lookup is case-insensitive.

The display downloads and decodes the separate reference WAV before scoring begins, then scans 2048-sample windows at 50% overlap to determine voiced frames and singable duration. Analysis yields between batches and is cancelled on display retirement or track replacement. Compact reference pitch data is cached for up to four assets, keyed by asset ID and indexed size/modification time. The main backing/video stream remains progressive. This port does not include Nightingale's ML vocal separation, automatic transcription, or an automatic YouTube analysis pipeline.

Set **Microphone delay (ms)** from 0 to 500 to compensate for input delay; the default is 80 ms. This is a manual setting for the current page. After at least twenty reference-backed observations, a confirmed completed performance can publish its result to the room; the server validates and fences telemetry and retains the latest twenty results. Without a usable reference the UI labels the separate fallback **Pitch stability**. Reference preparation failure reports a message and permits playback with a MIDI guide or the fallback.

Scoring uses the microphone connected to the display. Paired phones can stream microphone audio directly to the active TV over WebRTC, but those inputs currently feed the output gate rather than the display-local scoring analyser. Per-phone scoring is not included. See [scoring integration details](nightingale-scoring-integration.md) and [third-party notices](../THIRD_PARTY_NOTICES.md).

## Recording

Enable the display microphone, load a song, then choose **Record performance**. Supported browsers use `MediaRecorder` and a lyric/video/CD+G canvas. Local and Invidious-streamed songs export a performance video with mixed microphone/music audio plus separate microphone and music audio stems. Formats follow browser support (WebM/Opus, MP4 or OGG). The microphone never connects to speakers.

YouTube recordings include native video and backing audio, mixed with the display microphone. Each recording has inline playback controls and a download link.

Stop recording explicitly or let track change/end, display release, disconnect or microphone disable stop it. A recording is bounded to thirty minutes and approximately 256 MiB of accumulated chunks. Playback controls and download links appear on the display. Files stay in browser memory until downloaded or the page is closed; there is no server upload, recording library or camera capture. Download important recordings before leaving/reloading the page. Once retained exports reach 256 MiB, download them and use **Clear downloaded recording files from memory** before starting another recording. Clearing removes browser-memory download links, not files already downloaded. Permission denial and missing recording APIs surface errors; actual recording compatibility and microphone/room-noise quality require device testing.

## Public rooms and phone microphones

The root dashboard offers Launch karaoke and Control. Launch creates an anonymous owner and isolated room without credentials. Pairing QR links consume their fragment invitation automatically on `/control`; the manual six-digit code remains stable until the room ends. Public rooms permit paired phones to play, pause, skip, seek, change volume and tempo. End room disconnects participants; the next launch creates a new room.

A phone microphone starts only after the visitor presses Enable phone microphone and grants browser permission. Signaling is authorized against room membership and the current display lease. Audio travels directly over WebRTC into the TV's fenced Web Audio output. Disconnect, device removal, display release and room end close connections. No STUN/TURN service is configured: direct connectivity must be available, typically on the same LAN. HTTPS is required on phones. Physical microphone quality, acoustic feedback, latency and mobile browser compatibility still need device testing.

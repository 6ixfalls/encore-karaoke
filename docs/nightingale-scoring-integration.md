# Nightingale scoring integration review

Reviewed upstream commit `ab3304bb2f36fe8046013a97cd1d498b7a0fb6ca` on October 19, 2026.
The scorer port is implemented. This document records the source review, adaptation decisions and remaining scope.

## Upstream behavior

Nightingale's [scoring documentation](https://nightingale.cafe/docs/scoring/)
describes comparing microphone pitch with reference vocals, or with the original
mix when separated vocals are unavailable. The original mix is less accurate.

The implementation is in:

- [`lib/pitch/state.ts`](https://github.com/rzru/nightingale/blob/ab3304bb2f36fe8046013a97cd1d498b7a0fb6ca/client/src/features/playback/lib/pitch/state.ts): octave-independent semitone comparison, time-weighted accumulation, reference-window sampling and singable-duration estimation.
- [`lib/pitch/detect.ts`](https://github.com/rzru/nightingale/blob/ab3304bb2f36fe8046013a97cd1d498b7a0fb6ca/client/src/features/playback/lib/pitch/detect.ts): Pitchy-based detection with separate reference and microphone gates.
- [`hooks/use-pitch-scoring.ts`](https://github.com/rzru/nightingale/blob/ab3304bb2f36fe8046013a97cd1d498b7a0fb6ca/client/src/features/playback/hooks/use-pitch-scoring.ts): connects decoded reference audio, latency compensation, microphone pitch and playback time.

The scorer uses a 2048-sample window. Pitch differences are folded into one
octave, with credit decreasing linearly to zero at six semitones. Credit is
weighted by playback time, with each update capped at 100 ms, and divided by
the estimated singable duration of the reference. The upstream score is 0–1000.
Its default microphone delay compensation is 80 ms, adjustable from 0 to 500 ms.

Reference preparation and live scoring are different stages. Upstream scans a
decoded reference AudioBuffer to estimate singable duration before scoring.
Copying only the live comparison cannot generate reference vocals or recover a
melody from an instrumental karaoke video.

## Implemented Encore integration

- Ported the three upstream pitch modules into `src/hosted/scoring/`, retaining
  their calculation and detector settings with explicit provenance headers.
- Added `reference.js` to adapt MIDI guides and prepared vocal WAVs to the
  scorer. Reference scans use the upstream detector, frame size and overlap,
  yield periodically, and cache compact pitch frames rather than decoded audio.
- Added `<song-stem>.vocals.wav` companion indexing and exact-case YouTube ID
  matching through `<videoId>.vocals.wav`. Reference files are authorized media
  assets and do not appear as songs. Size, decoded duration and channels are bounded.
- Added manual 0–500 ms input-delay adjustment, defaulting to upstream's 80 ms.
- Kept Encore's existing 0–100 score contract by dividing the upstream result
  by ten. Score observations include missed reference vocals; the fallback
  pitch-stability mode stays explicitly separate.
- Added a high-water playback position so seeks and repeated regions cannot
  increase earned credit. Paused/buffering frames award no elapsed-time credit.
  Comparison samples the midpoint of the credited interval, avoiding the loss
  of a complete final interval at a MIDI note boundary.
- Kept reference preparation separate from progressive backing-track playback.
  The reference file is decoded/scanned before playback. Automatic original-song
  acquisition, ML stem separation, transcription and melody generation are not
  included in this port. Existing prepared references are required for YouTube
  melody scoring.

The current phone microphone route feeds the TV output gate. It does not feed
the display-local scoring analyser. Scoring phone singers requires a per-phone
analysis input and explicit singer selection; switching the scoring formula
alone would not add that capability.

## Verification

Automated fixtures cover upstream similarity and accumulation behavior,
frequency-independent time weighting, octave shifts, detuning, silent microphone
sections, overlapping MIDI notes, instrumental gaps, delay offsets, replay and
seek protection, track replacement, stale preparation cancellation, and parity
between asynchronous reference analysis and upstream singable-time estimation.
HTTP tests cover sidecar indexing and room-authorized reference access. Physical
microphone/latency quality remains a device acceptance check.

## Source reuse decision

The user authorized a direct port and GPL distribution. Encore's combined
application now uses GPL-3.0-only. The original MIT notice is retained in
`THIRD_PARTY_NOTICES.md`; it does not relicense Nightingale-derived files as MIT.
Upstream provenance, modification date, Pitchy and fft.js MIT notices are included.
The build copies the GPL license and notices to the browser distribution and
packages the actual build inputs into `source.tar.gz`. The footer links all three.
The container build includes these materials as well. No change was published
or deployed by this integration work.

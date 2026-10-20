# Hosted media

The hosted server supports YouTube media through yt-dlp. Disk-library scanning, local audio/video/MIDI serving, and companion-file lookup are removed from the hosted runtime. Some standalone format utilities remain in the repository for the legacy desktop code; they are not bundled into the hosted player.

Search by song or artist on YouTube Music, or paste a YouTube/YouTube Music URL or ID. Song titles and artists come from YouTube Music metadata through yt-dlp. Pasted links are resolved before queueing. Streams are limited to ten minutes. The main karaoke screen is the only playback device for its room; phones join using its code or QR to queue and control.

## Instrumental preparation and scoring

FFmpeg decodes source audio to 44.1 kHz stereo PCM. Demucs `htdemucs` processes eight-second chunks with left/right context, separates vocals and supplies the instrumental. FFmpeg muxes the original video with instrumental AAC into fragmented MP4 for browser playback. Signed source URLs and processing frames are cached only in memory. The instrumental is retained in a private temporary directory (at most 1 GiB per job) until playback is retired. The image contains model weights, so no writable persistent model volume is required.

The song is prepared in full before playback starts. This adds an initial wait for model inference, but provides repeatable HTTP byte ranges for seeking anywhere and resuming at the paused position. One job runs per server. Stalled processing, cancellation, stale playback or screen ownership, room end and server shutdown stop the job. Failed separation reports an error; it never substitutes the original vocal mix. Temporary media is removed on cancellation, failure, room end and server shutdown; jobs also have a thirty-minute lifetime. Switching tabs does not pause or release playback. Disconnect and lease expiry still mute output.

The container reserves up to 1200 MiB of temporary memory for the prepared instrumental and processing scratch space. Custom deployments must provide equivalent writable temporary storage; this is ephemeral media, not a persistent song library.

The server analyzes vocal PCM into timestamped pitch references for Nightingale scoring. The main-screen microphone is compared with those references, allowing octave equivalence. Scores remain provisional until reference processing completes. Missed vocal time reduces the final result. Microphone delay can be adjusted from 0–500 ms. Microphone capture, permissions and recording are browser-controlled; recent scores are ephemeral room state.

Phone microphones use direct room-scoped WebRTC into the main screen's audio gate. They need browser permission and a trusted HTTPS origin. No TURN relay is configured; direct LAN connectivity is normally needed. Phone audio currently feeds playback rather than the main-screen scoring analyser.

## Timed lyrics

YouTube Music supplies lyrics when it exposes timestamps for the exact video ID being played. Start/end cues are preserved; untimed lyrics are omitted rather than assigned estimated timings. The server's lyrics provider interface supports ordered fallbacks to additional timing APIs. A missing or failed lyrics response does not block playback. YouTube Music uses an unofficial client endpoint, so availability can vary or change.

## Recording

The main screen can record a performance video with mixed microphone/music audio and separate audio stems. Browser format support varies. Recordings stay in browser memory, with preview and download links; the server stores none. Track change/end, disconnect or microphone disable stops recording. Download before leaving the page. Memory usage is bounded to approximately 256 MiB; clear downloaded exports before recording more.

## Dependencies and GPU

The container installs yt-dlp, FFmpeg, Python, PyTorch and `server/separation-requirements.txt`, and downloads `htdemucs` model weights during its build. For a local Node setup, install those dependencies separately. Default inference is CPU, with video stream copy. Set `SEPARATION_DEVICE=cuda:0` for NVIDIA inference; `FFMPEG_VIDEO_MODE=nvidia` independently enables CUDA video decode and NVENC encoding. See `deploy/compose.gpu.yaml` and the [operator guide](server-hosted-operations.md).

# Hosted media

The hosted server supports YouTube media through yt-dlp. Disk-library scanning, local audio/video/MIDI serving, companion-file lookup and prepared vocal files are removed from the hosted runtime. Some standalone format utilities remain in the repository for the legacy desktop code; they are not bundled into the hosted player.

Search by song or artist, or paste a YouTube URL/ID. Search and extraction use yt-dlp without an API key, disk cache or complete-song download. Streams are limited to ten minutes. The main karaoke screen is the only playback device for its room; phones join using its code or QR to queue and control.

## Live separation and scoring

FFmpeg decodes source audio to 44.1 kHz stereo PCM. Demucs `htdemucs` processes eight-second chunks with left/right context, separates vocals and supplies the instrumental. FFmpeg muxes the original video with instrumental AAC into fragmented MP4 for browser playback. Signed source URLs and processing frames are cached only in memory. The image contains model weights, so no writable persistent model volume is required.

The first output needs source buffering and model inference. Playback buffers if processing cannot keep up. One job runs per server. Stalled processing, cancellation, stale playback or screen ownership, room end and server shutdown stop the job. Failed separation reports an error; it never substitutes the original vocal mix. Sequential separation streams cannot seek.

The server analyzes vocal PCM into timestamped pitch references for Nightingale scoring. The main-screen microphone is compared with those references, allowing octave equivalence. Scores remain provisional until reference processing completes. Missed vocal time reduces the final result. Microphone delay can be adjusted from 0–500 ms. Microphone capture, permissions and recording are browser-controlled; recent scores are ephemeral room state.

Phone microphones use direct room-scoped WebRTC into the main screen's audio gate. They need browser permission and a trusted HTTPS origin. No TURN relay is configured; direct LAN connectivity is normally needed. Phone audio currently feeds playback rather than the main-screen scoring analyser.

## Recording

The main screen can record a performance video with mixed microphone/music audio and separate audio stems. Browser format support varies. Recordings stay in browser memory, with preview and download links; the server stores none. Track change/end, disconnect or microphone disable stops recording. Download before leaving the page. Memory usage is bounded to approximately 256 MiB; clear downloaded exports before recording more.

## Dependencies and GPU

The container installs yt-dlp, FFmpeg, Python, PyTorch and `server/separation-requirements.txt`, and downloads `htdemucs` model weights during its build. For a local Node setup, install those dependencies separately. Default inference is CPU, with video stream copy. Set `SEPARATION_DEVICE=cuda:0` for NVIDIA inference; `FFMPEG_VIDEO_MODE=nvidia` independently enables CUDA video decode and NVENC encoding. See `deploy/compose.gpu.yaml` and the [operator guide](server-hosted-operations.md).

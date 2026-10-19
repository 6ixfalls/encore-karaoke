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
| `<videoId>.vocals.wav` anywhere in the library | Compatibility reference asset; automatic YouTube separation currently supplies the live reference instead |

MIDI rendering is limited to 4 MiB, 200,000 events, 30,000 notes and 20 minutes. CD+G companions are limited to 32 MiB and LRC to 2 MiB. Local synthesis uses simple waveforms with program families and short percussion tones. It does not reproduce the desktop GM soundfont, sustain/controllers, pitch bend or SysEx effects. MIDI SMPTE timing and type 2 files are rejected. AVI and proprietary formats, archives, `.cho`, manifests, metadata import and server transcoding remain future work. Unplayable native codecs report playback failure and leave the reservation available for an explicit retry or skip.

## YouTube

Paste a supported YouTube URL or 11-character ID in the Songbook, optionally enter a title, and select **Find / queue video**. Guests can queue within their existing reservation limits. Video IDs are validated; the server never fetches user-supplied URLs.

YouTube search and extraction now use **yt-dlp**, with no Invidious service or API key. The container installs yt-dlp, FFmpeg and the maintained [adefossez/demucs](https://github.com/adefossez/demucs) fork pinned at `2883f3db65617d6d178c6ed10d869dc14e44e59b` (4.1.0). Local installs need Python 3.10–3.13, FFmpeg, and the dependencies in `server/separation-requirements.txt`. Set `SEPARATION_PYTHON` to that Python executable and optionally `YT_DLP_PATH`/`FFMPEG_PATH` to non-default executable paths. yt-dlp uses the installed Node runtime for JavaScript challenges. Its version is pinned and must be updated as YouTube extraction changes. Access may also depend on the deployment IP, video restrictions and YouTube token requirements.

For a local install (choose an installed supported Python version):

```sh
python3.13 -m venv .venv-separation
.venv-separation/bin/python -m pip install -r server/separation-requirements.txt
.venv-separation/bin/python -c 'from demucs.pretrained import get_model; get_model("htdemucs")'
npm run build
SEPARATION_PYTHON="$PWD/.venv-separation/bin/python" YT_DLP_PATH="$PWD/.venv-separation/bin/yt-dlp" npm start
```

FFmpeg and Node must be available on the executable path, or set `FFMPEG_PATH`.
For the supplied deployment, rebuild the container image to install these
components and preload the model; no Invidious configuration is needed.

The active display automatically starts separation for each queued YouTube track. yt-dlp extracts adaptive H.264 video/M4A audio URLs or a combined MP4 fallback without downloading the complete song. FFmpeg decodes incoming audio to 44.1 kHz stereo PCM. The worker adapts Nightingale's Demucs normalization, `htdemucs` vocal inference and residual instrumental calculation to eight-second chunks with one second of left/right context. The first output needs up to nine seconds of source audio plus model initialization/inference time. The model stays loaded for that stream. No complete-song audio or video file is required or retained on disk.

The separated instrumental is encoded as AAC and muxed with the original video into fragmented MP4. That same native media element feeds the existing output gate and mixed performance recorder. Vocal PCM is analyzed for pitch on the server and sent as compact timestamped reference frames through the display-authorized API. The score is provisional while future singable duration is still being discovered; final score telemetry is withheld until reference processing completes. Delayed reference frames can catch up with a bounded queue of microphone observations. An instrumental-only source cannot recover missing original vocals; model leakage may still produce imperfect targets.

This is buffered, incremental separation, **not zero-delay inference**. If processing cannot sustain playback speed the media buffers rather than substituting the original vocal mix. The initial stream is sequential and does not advertise byte ranges; seeking is disabled for this sequential stream. Play/pause, native tempo, scoring and local recording remain available. Chunk boundaries can differ from whole-file model output. One separation job is allowed across the server at a time, tracks are limited to ten minutes, and a job is terminated on cancellation, stale playback/display lease, stalled progress, subprocess failure or server shutdown. Failed processing is surfaced explicitly and does not fall back to original vocals.

The supplied image preloads model weights at build time and reads them offline at runtime. Compose limits the service to 6 GiB RAM and four CPUs for a single worker; the old 512 MiB limit is unsuitable. Model initialization, compute performance and native media buffering vary by hardware.

### NVIDIA GPU configuration

Demucs and FFmpeg can use NVIDIA GPUs independently. The default deployment uses CPU Demucs and copies the H.264 video without transcoding. Stream copy is generally the cheapest video path; GPU video processing is optional and does not speed up audio decoding or AAC encoding.

For Docker on a supported NVIDIA host, install the NVIDIA driver and [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html), configure Docker GPU access, then run from `deploy/`:

```sh
docker compose -f compose.yaml -f compose.gpu.yaml up -d --build
```

The overlay builds with PyTorch/torchaudio 2.8.0 CUDA 12.8 wheels, exposes NVIDIA devices and compute/video driver libraries, and defaults to `SEPARATION_DEVICE=cuda:0`, `FFMPEG_VIDEO_MODE=nvidia`, and `FFMPEG_GPU=0`. The host driver must support CUDA 12.8, and the GPU must support H.264 NVDEC/NVENC for NVIDIA video mode. This requires a GPU-capable Docker host; Docker Desktop on macOS does not provide NVIDIA passthrough. Keep the same two Compose files for subsequent stop/update commands. Explicit values in the environment or `.env` override the overlay defaults.

For Demucs acceleration with the existing video-copy path, set `FFMPEG_VIDEO_MODE=copy` in `deploy/.env` and use the same overlay. The base CPU image alone cannot enable CUDA inference by changing an environment variable.

For a local installation, install matching CUDA PyTorch and torchaudio wheels into the separation environment before installing the requirements:

```sh
.venv-separation/bin/pip install torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu128
.venv-separation/bin/pip install -r server/separation-requirements.txt
SEPARATION_DEVICE=cuda:0 FFMPEG_VIDEO_MODE=nvidia FFMPEG_GPU=0 \
  SEPARATION_PYTHON="$PWD/.venv-separation/bin/python" \
  YT_DLP_PATH="$PWD/.venv-separation/bin/yt-dlp" npm start
```

Use an FFmpeg build with CUDA decoding and `h264_nvenc` support (`FFMPEG_PATH` can select it). In NVIDIA mode, the server places CUDA options before the video input and encodes H.264 with NVENC, while the audio path remains CPU PCM/AAC. `SEPARATION_DEVICE=cuda:N` selects the PyTorch device; `FFMPEG_GPU=N` selects the FFmpeg device using the indices visible inside the process/container. An explicitly requested GPU mode fails if unavailable; it does not silently fall back to CPU or original vocals.

Verify the deployment's hardware access before playback:

```sh
docker compose -f compose.yaml -f compose.gpu.yaml exec encore python -c 'import torch; print(torch.__version__, torch.cuda.is_available()); print(torch.cuda.get_device_name(0))'
docker compose -f compose.yaml -f compose.gpu.yaml exec encore ffmpeg -hide_banner -encoders
docker compose -f compose.yaml -f compose.gpu.yaml exec encore ffmpeg -hide_banner -hwaccels
```

The FFmpeg listings should contain `h264_nvenc` and `cuda`; listings establish build support, while an actual YouTube playback verifies decoding, encoding, and inference with the installed driver. See [NVIDIA's FFmpeg guide](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/ffmpeg-with-nvidia-gpu/index.html), [PyTorch wheel versions](https://pytorch.org/get-started/previous-versions/), and [Compose GPU setup](https://docs.docker.com/compose/how-tos/gpu-support/).

## Cheers and scores

Any room guest or host can submit a literal cheer of up to 120 characters. Cheers are shared via authorized room snapshots, deduplicated by command ID, expire after eight seconds, and are capped at twelve recent messages. Existing command rate limits apply. Cheers do not require playback-control permission.

On the active display, choose **Enable microphone & scoring**. Capture requires a secure origin (or localhost) and explicit browser permission. Input is analyzed and optionally recorded locally; it is never amplified or sent to the server. Disable, disconnect, page hiding or display release stops microphone tracks. A late permission response cannot reactivate a retired display.

Encore now ports Nightingale's GPL-3.0 pitch detector adapters and scorer, using Pitchy for microphone/reference detection. Detected pitch is compared in semitones with octave differences accepted; similarity decreases linearly to zero at six semitones. Earned credit is weighted by elapsed media time and divided by the reference's total singable duration. Nightingale's 0–1000 result is displayed and shared as 0–100 (one decimal place). An update earns at most 100 ms of credit. A missed vocal section reduces the final score; an instrumental gap does not earn credit. The displayed value grows toward the final whole-song score, rather than showing accuracy only for the moments already sung. Seeking forward earns no skipped time, and replaying a previously visited region cannot add credit again. These are casual performance metrics, not a calibrated vocal assessment.

Existing MIDI guides work immediately. Overlapping notes count once toward singable duration; for MIDI songs, all non-percussion notes are possible targets, so a dedicated monophonic vocal guide is preferable. For local files, a prepared `.vocals.wav` reference takes precedence over MIDI. References must be at most 32 MiB, ten minutes and two channels. They should contain isolated original vocals synchronized exactly to the backing track/video, including any intro silence. Instrumental karaoke audio cannot supply a reliable vocal melody. YouTube playback automatically builds a live reference from the streamed vocal stem; prepared YouTube sidecars remain indexed for compatibility but are not used in this automatic path. Local reference companion lookup is case-insensitive.

The display downloads and decodes the separate reference WAV before scoring begins, then scans 2048-sample windows at 50% overlap to determine voiced frames and singable duration. Analysis yields between batches and is cancelled on display retirement or track replacement. Compact reference pitch data is cached for up to four assets, keyed by asset ID and indexed size/modification time. The main backing/video stream remains progressive. Automatic streamed YouTube separation is implemented as described above. Local-file automatic separation and automatic transcription remain outside this path.

Set **Microphone delay (ms)** from 0 to 500 to compensate for input delay; the default is 80 ms. This is a manual setting for the current page. After at least twenty reference-backed observations, a confirmed completed performance can publish its result to the room; the server validates and fences telemetry and retains the latest twenty results. Without a usable reference the UI labels the separate fallback **Pitch stability**. Reference preparation failure reports a message and permits playback with a MIDI guide or the fallback.

Scoring uses the microphone connected to the display. Paired phones can stream microphone audio directly to the active TV over WebRTC, but those inputs currently feed the output gate rather than the display-local scoring analyser. Per-phone scoring is not included. See [scoring integration details](nightingale-scoring-integration.md) and [third-party notices](../THIRD_PARTY_NOTICES.md).

## Recording

Enable the display microphone, load a song, then choose **Record performance**. Supported browsers use `MediaRecorder` and a lyric/video/CD+G canvas. Local and yt-dlp-streamed songs export a performance video with mixed microphone/music audio plus separate microphone and music audio stems. Formats follow browser support (WebM/Opus, MP4 or OGG). The microphone never connects to speakers.

YouTube recordings include native video and backing audio, mixed with the display microphone. Each recording has inline playback controls and a download link.

Stop recording explicitly or let track change/end, display release, disconnect or microphone disable stop it. A recording is bounded to thirty minutes and approximately 256 MiB of accumulated chunks. Playback controls and download links appear on the display. Files stay in browser memory until downloaded or the page is closed; there is no server upload, recording library or camera capture. Download important recordings before leaving/reloading the page. Once retained exports reach 256 MiB, download them and use **Clear downloaded recording files from memory** before starting another recording. Clearing removes browser-memory download links, not files already downloaded. Permission denial and missing recording APIs surface errors; actual recording compatibility and microphone/room-noise quality require device testing.

## Public rooms and phone microphones

The root dashboard offers Launch karaoke and Control. Launch creates an anonymous owner and isolated room without credentials. Pairing QR links consume their fragment invitation automatically on `/control`; the manual six-digit code remains stable until the room ends. Public rooms permit paired phones to play, pause, skip, seek, change volume and tempo. End room disconnects participants; the next launch creates a new room.

A phone microphone starts only after the visitor presses Enable phone microphone and grants browser permission. Signaling is authorized against room membership and the current display lease. Audio travels directly over WebRTC into the TV's fenced Web Audio output. Disconnect, device removal, display release and room end close connections. No STUN/TURN service is configured: direct connectivity must be available, typically on the same LAN. HTTPS is required on phones. Physical microphone quality, acoustic feedback, latency and mobile browser compatibility still need device testing.

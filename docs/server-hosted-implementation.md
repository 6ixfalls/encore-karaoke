# Hosted implementation status

The current server uses process-local memory for rooms, participants, pairing codes, queues, scores, playback heartbeats, command retries and rate limits. There is no application database, disk library, migration, backup/restore service, account login, administrator role, display invitation or display takeover workflow.

The dashboard launches one main karaoke screen per room. Phones join through its stable code or QR. Temporary tab membership scopes requests to the room. The main screen alone can start the audio output; joined controllers cannot claim it. All room state disappears on restart.

YouTube search/extraction uses yt-dlp; FFmpeg/Demucs process media through bounded live streams. The application container has no persistent volumes. Proxy TLS certificate storage is managed separately by Caddy. Model weights are immutable image assets. Recording exports stay in browser memory.

Automated checks cover room ownership and reset, pairing, controller access, Socket.IO queues, admission/deduplication, output fencing, separation, yt-dlp and scoring. Manual release checks remain for real-device audio and microphone timing, browser compatibility, recording, HTTPS provisioning, NVIDIA performance and container resource limits. The [overhaul draft](server-hosted-overhaul-draft.md) records historical design context and is not the current storage or display specification.

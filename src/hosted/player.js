import { parseLrc } from "./lrc.js";
import { parseMidi, renderMidi } from "./midi.js";
import { Cdg } from "./cdg.js";

export class BrowserPlayer {
  constructor(services, { telemetry, lyrics, error, released, media, cdg, performance: performanceTools }) {
    Object.assign(this, { services, telemetry, lyrics, error, released });
    try {
      this.pendingRelease = JSON.parse(sessionStorage.getItem("encore-display-release") || "null");
    } catch { this.pendingRelease = null; }
    this.generation = null;
    this.revalidated = false;
    this.retired = new Set();
    this.started = false;
    this.loaded = null;
    this.audio = media || new Audio();
    this.localMedia = this.audio;
    this.cdgCanvas = cdg;
    this.performanceTools = performanceTools;
    this.audio.preload = "auto";
    this.loadingVersion = 0;
    this.bindMedia(this.audio);
    this.lyricsTimer = setInterval(() => this.renderLyrics(), 50);
    this.timer = setInterval(() => {
      if (this.generation && this.valid() && this.loaded && !this.loading)
        this.report(this.audio.paused ? "paused" : this.mediaState);
    }, 1000);
    window.addEventListener("pagehide", () => this.stop().catch(() => {}));
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && this.generation)
        this.stop().catch((error) => this.error(error));
    });
  }
  bindMedia(media) {
    for (const [event, state] of Object.entries({
      playing: "playing",
      pause: "paused",
      waiting: "buffering",
      ended: "ended",
      error: "failed",
    })) {
      media.addEventListener(event, () => {
        if (this.audio !== media) return;
        if (event === "playing" && (!this.valid() || this.room?.desired !== "playing")) { media.pause(); return; }
        if (this.generation && this.loaded && this.valid()) {
          if (state === "failed") {
            this.failPlayback(new Error("media_unavailable"), this.loaded);
            return;
          }
          if (this.loading) return;
          this.mediaState = state;
          this.report(state);
        }
      });
    }
  }
  clearMedia() {
    const separation = this.separation;
    this.separation = null;
    clearTimeout(this.separationTimer);
    if (separation) this.services.request(`/api/rooms/${separation.roomId}/separation/${separation.id}/stop`,
      { method: "POST", body: {} }).catch(() => {});
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.audio = this.localMedia;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.cdg = null;
    this.song = null;
    this.guideNotes = [];
    if (this.localMedia.hidden !== undefined) this.localMedia.hidden = true;
    if (this.cdgCanvas) this.cdgCanvas.hidden = true;
    this.performanceTools?.trackChanged();
  }
  async initialize() {
    if (this.context?.state === "running") return;
    if (this.context) {
      await this.context.resume();
      this.started = true;
      return;
    }
    this.context = new AudioContext({ latencyHint: "interactive" });
    this.gate = this.context.createGain();
    this.gate.gain.value = 0;
    // The media element has exactly one route to the speakers: this initially closed output gate.
    this.source = this.context.createMediaElementSource(this.audio);
    this.source.connect(this.gate);
    this.gate.connect(this.context.destination);
    this.context.addEventListener("statechange", () => {
      if (this.context.state !== "running" && this.generation)
        this.stop().catch((error) => this.error(error));
    });
    await this.context.resume();
    this.started = true;
  }
  valid() {
    return (
      this.connected &&
      this.revalidated &&
      this.generation &&
      !this.retired.has(this.generation) &&
      performance.now() < this.expires &&
      this.context?.state === "running"
    );
  }
  arm(grant, requestStarted) {
    if (this.retired.has(grant.generation) || this.context.state !== "running")
      throw new Error("stale_display");
    // Use round-trip elapsed time, never server/browser wall-clock agreement.
    const budget =
      grant.leaseMs -
      (performance.now() - requestStarted) -
      300 -
      (this.context.outputLatency || 0) * 1000;
    if (budget <= 0) throw new Error("lease_response_too_late");
    this.generation = grant.generation;
    this.revalidated = true;
    this.expires = performance.now() + budget;
    const now = this.context.currentTime;
    this.gate.gain.cancelScheduledValues(now);
    this.gate.gain.setValueAtTime(this.room?.volume ?? 0.65, now);
    this.gate.gain.setValueAtTime(0, now + budget / 1000);
    // Retire media and microphone capture when the display lease expires.
    clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(
      () => this.stop().catch((error) => this.error(error)),
      budget,
    );
  }
  async claim(roomId) {
    await this.initialize();
    await this.releasePending();
    this.roomId = roomId;
    const start = performance.now();
    const grant = await this.services.request(
      `/api/rooms/${roomId}/display/claim`,
      { method: "POST", body: {} },
    );
    this.releaseToken = grant.releaseToken;
    try {
      this.arm(grant, start);
    } catch (error) {
      this.generation = grant.generation;
      await this.stop();
      throw error;
    }
    this.renewTimer = setInterval(
      () => {
        const generation = this.generation;
        this.renew().catch((error) => {
          if (this.generation !== generation) return;
          this.error(error);
          this.stop().catch(() => {});
        });
      },
      2000,
    );
    await this.update(await this.services.request(`/api/rooms/${roomId}`));
  }
  async renew() {
    if (!this.generation || this.renewing || !this.connected) return;
    this.renewing = true;
    const generation = this.generation;
    const start = performance.now();
    try {
      const grant = await this.services.request(
        `/api/rooms/${this.roomId}/display/renew`,
        { method: "POST", body: { generation } },
      );
      if (this.generation === generation && this.connected)
        this.arm(grant, start);
    } finally {
      this.renewing = false;
    }
  }
  async handleTelemetryAck(report, ack) {
    // Track changes can overtake reports; lease failures still retire output.
    // Replies for a retired generation must never stop its replacement.
    if (report.leaseGeneration !== this.generation || !ack.error ||
        ack.error === "stale_playback") return;
    this.error(new Error(ack.error));
    await this.stop();
  }
  report(state, playbackId = this.loaded) {
    if (state === "ended" && this.separation && !this.separation.finalized) {
      const job = this.separation;
      if (!job.finishing) {
        job.finishing = true;
        clearTimeout(this.separationTimer);
        this.services.request(`/api/rooms/${job.roomId}/separation/${job.id}`).then(snapshot => {
          if (this.separation !== job || this.loaded !== playbackId || !this.valid()) return;
          this.performanceTools?.updateLiveReference?.(snapshot);
          job.finalized = true;
          this.report(state, playbackId);
        }).catch(error => {
          if (this.separation === job) this.failPlayback(error, playbackId);
        });
      }
      return;
    }
    this.telemetry({
      leaseGeneration: this.generation,
      playbackId,
      state,
      position: Number.isFinite(this.audio.currentTime)
        ? this.audio.currentTime
        : 0,
      rate: this.audio.playbackRate,
      ...(state === "ended" && this.performanceTools?.result() ? { score: this.performanceTools.result() } : {}),
    });
  }
  async update(room) {
    if (room && this.room?.id === room.id && room.revision < this.room.revision) return;
    this.room = room;
    if (!room || !this.generation) return;
    if (
      room.status === "ended" ||
      room.lease?.generation !== this.generation ||
      room.lease?.retired ||
      room.lease?.releaseRequested
    ) {
      await this.stop();
      return;
    }
    if (!this.connected || !this.revalidated) {
      this.audio.pause();
      this.gate.gain.setValueAtTime(0, this.context.currentTime);
      return;
    }
    if (!this.valid()) {
      await this.stop();
      return;
    }
    // Do not cancel the audio-thread cutoff when changing volume.
    this.gate.gain.setValueAtTime(room.volume, this.context.currentTime);
    this.audio.playbackRate = room.tempo;
    if (!room.current) {
      this.loadingVersion++;
      this.loaded = null;
      this.loading = false;
      this.clearMedia();
      this.lines = [];
      this.lyrics("", "");
      return;
    }
    const playbackId = room.current.playbackId;
    if (this.loaded !== playbackId) {
      // Failure snapshots pause playback; wait for an explicit resume before retrying.
      if (this.failedPlaybackId === playbackId && room.desired !== "playing") return;
      const version = ++this.loadingVersion;
      this.loading = true;
      this.mediaState = "loading";
      this.loaded = playbackId;
      this.lines = [];
      this.clearMedia();
      try {
        const song = await this.services.request(
          `/api/library/songs/${room.current.songId}?roomId=${room.id}`,
        );
        if (
          version !== this.loadingVersion ||
          !this.valid() ||
          this.loaded !== playbackId
        )
          return;
        const getBuffer = async (id, limit) => {
          const response = await fetch(this.services.media(id, room.id));
          if (!response.ok || Number(response.headers?.get("content-length")) > limit) throw new Error("companion_unavailable");
          const buffer = await response.arrayBuffer();
          if (buffer.byteLength > limit) throw new Error("companion_too_large");
          return buffer;
        };
        if (song.format === "youtube") {
          const separated = await this.services.request(`/api/rooms/${room.id}/separation`,
            { method: "POST", body: { playbackId } });
          if (version !== this.loadingVersion || !this.valid()) {
            this.services.request(`/api/rooms/${room.id}/separation/${separated.id}/stop`, { method: "POST", body: {} }).catch(() => {});
            return;
          }
          this.separation = { id: separated.id, roomId: room.id };
          this.audio.src = separated.media;
          this.audio.hidden = false;
          this.performanceTools?.beginLiveReference?.();
          this.pollSeparation(version, playbackId);
        } else if (song.format === "midi") {
          const midi = parseMidi(await getBuffer(song.assetId, 4 * 1024 * 1024));
          const blob = await renderMidi(midi);
          if (version !== this.loadingVersion || !this.valid()) return;
          this.objectUrl = URL.createObjectURL(blob);
          this.audio.src = this.objectUrl;
          this.lines = midi.lyrics;
          this.guideNotes = midi.notes.filter((n) => n.channel !== 9);
        } else {
          this.audio.src = this.services.media(song.assetId, room.id);
          this.audio.hidden = song.format !== "video";
        }
        this.song = song;
        if (song.guideId) {
          const guide = parseMidi(await getBuffer(song.guideId, 4 * 1024 * 1024));
          if (version !== this.loadingVersion || !this.valid()) return;
          this.guideNotes = guide.notes.filter((n) => n.channel !== 9);
        }
        if (song.cdgId && this.cdgCanvas) {
          const buffer = await getBuffer(song.cdgId, 32 * 1024 * 1024);
          if (version !== this.loadingVersion || !this.valid()) return;
          this.cdg = new Cdg(buffer, this.cdgCanvas);
          this.cdgCanvas.hidden = false;
        }
        if (song.lyricsId) {
          const response = await fetch(
            this.services.media(song.lyricsId, room.id),
          );
          if (!response.ok) throw new Error("lyrics_unavailable");
          const lines = parseLrc(await response.text());
          if (version !== this.loadingVersion || !this.valid()) return;
          this.lines = lines;
        }
        if (version !== this.loadingVersion || !this.valid()) return;
        if (song.format !== "youtube") await this.performanceTools?.prepareReference?.(this, song, getBuffer,
          () => version === this.loadingVersion && this.valid() && this.loaded === playbackId);
        if (version !== this.loadingVersion || !this.valid()) return;
        this.loading = false;
        this.mediaState = "ready";
        this.failedPlaybackId = null;
      } catch (error) {
        if (version === this.loadingVersion) {
          this.failPlayback(error, playbackId);
        }
        return;
      }
    }
    if (
      this.loading ||
      !this.valid() ||
      this.loaded !== this.room?.current?.playbackId
    )
      return;
    const current = this.room.current;
    this.audio.playbackRate = this.room.tempo;
    if (current.seek && this.seekId !== current.seek.id) {
      this.audio.currentTime = current.seek.position;
      this.seekId = current.seek.id;
    }
    if (this.room.desired === "playing") {
      if (this.audio.paused && !this.audio.ended) {
        const generation = this.generation;
        const version = this.loadingVersion;
        await this.audio.play().catch((error) => {
          if (
            generation !== this.generation ||
            version !== this.loadingVersion ||
            playbackId !== this.loaded ||
            playbackId !== this.room?.current?.playbackId ||
            this.room.desired !== "playing" ||
            !this.valid()
          ) return;
          this.error(error);
          this.report("failed", playbackId);
        });
      }
    } else this.audio.pause();
  }
  async pollSeparation(version, playbackId) {
    const job = this.separation;
    if (!job || job.finishing || version !== this.loadingVersion || !this.valid()) return;
    try {
      const snapshot = await this.services.request(`/api/rooms/${job.roomId}/separation/${job.id}`);
      if (this.separation !== job || job.finishing || version !== this.loadingVersion || !this.valid()) return;
      this.performanceTools?.updateLiveReference?.(snapshot);
      if (!snapshot.complete) this.separationTimer = setTimeout(() => this.pollSeparation(version, playbackId), 1000);
    } catch (error) {
      if (this.separation === job && !job.finishing && version === this.loadingVersion) this.failPlayback(error, playbackId);
    }
  }
  failPlayback(error, playbackId) {
    this.loadingVersion++;
    this.loaded = null;
    this.failedPlaybackId = playbackId;
    this.loading = false;
    this.clearMedia();
    this.lines = [];
    this.error(error);
    this.report("failed", playbackId);
  }
  renderLyrics() {
    const position = this.audio.currentTime;
    this.cdg?.render(position);
    this.performanceTools?.update(this);
    const index = (this.lines || []).findLastIndex(
      (line) => line.time <= position,
    );
    this.lyrics(
      index < 0 ? "♪" : this.lines[index].text,
      this.lines?.[index + 1]?.text || "",
    );
  }
  disconnected() {
    this.connected = false;
    this.revalidated = false;
    if (this.loading) {
      this.loadingVersion++;
      this.loading = false;
      this.loaded = null;
      this.clearMedia();
    }
    this.audio.pause();
    if (this.separation) { this.loaded = null; this.clearMedia(); }
    this.performanceTools?.stopMicrophone();
    // The armed audio-thread cutoff remains in force during a bounded reconnect grace period.
    // A reconnect never opens output by itself; a successful lease renewal must rearm it.
    if (this.gate) this.gate.gain.setValueAtTime(0, this.context.currentTime);
  }
  async stop() {
    if (this.stopping) return this.stopping;
    const generation = this.generation,
      releaseToken = this.releaseToken;
    this.generation = null;
    this.revalidated = false;
    this.releaseToken = null;
    if (generation) this.retired.add(generation);
    this.loadingVersion++;
    this.loading = false;
    this.loaded = null;
    clearInterval(this.renewTimer);
    clearTimeout(this.expiryTimer);
    if (this.gate) {
      this.gate.gain.cancelScheduledValues(this.context.currentTime);
      this.gate.gain.setValueAtTime(0, this.context.currentTime);
    }
    this.clearMedia();
    this.performanceTools?.stopMicrophone();
    this.lines = [];
    this.lyrics("", "");
    if (!generation) {
      if (this.pendingRelease) await this.releasePending();
      return;
    }
    const drainMs = Math.max(300, ((this.context.outputLatency || 0) + (this.context.baseLatency || 0)) * 1000 + 200);
    // Page unload may cancel the asynchronous release. The next page can finish
    // acknowledging this generation only after its synchronously muted output drains.
    this.pendingRelease = { roomId: this.roomId, generation, releaseToken, readyAfter: Date.now() + drainMs };
    try { sessionStorage.setItem("encore-display-release", JSON.stringify(this.pendingRelease)); } catch { /* Storage may be disabled. */ }
    this.stopping = (async () => {
      // Drain any hardware buffering before acknowledging a permanently retired generation.
      await this.context.suspend();
      await new Promise((resolve) => setTimeout(resolve, drainMs));
      await this.releasePending();
    })();
    try {
      await this.stopping;
    } finally {
      this.stopping = null;
    }
  }
  async releasePending() {
    const pending = this.pendingRelease;
    if (!pending) return;
    const remaining = (pending.readyAfter || 0) - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    await this.services.request(`/display-release/${pending.roomId}`, {
      method: "POST",
      keepalive: true,
      body: {
        generation: pending.generation,
        releaseToken: pending.releaseToken,
      },
    });
    if (this.pendingRelease === pending) {
      this.pendingRelease = null;
      try { sessionStorage.removeItem("encore-display-release"); } catch { /* Storage may be disabled. */ }
    }
    this.released();
  }
}

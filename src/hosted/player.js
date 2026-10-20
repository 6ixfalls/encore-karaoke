export class BrowserPlayer {
  constructor(services, { telemetry, lyrics, error, released, media, performance: performanceTools }) {
    Object.assign(this, { services, telemetry, lyrics, error, released });
    this.generation = null;
    this.revalidated = false;
    this.retired = new Set();
    this.started = false;
    this.loaded = null;
    this.audio = media || new Audio();
    this.localMedia = this.audio;
    this.performanceTools = performanceTools;
    this.audio.preload = "auto";
    this.loadingVersion = 0;
    this.bindMedia(this.audio);
    this.lyricsTimer = setInterval(() => this.renderLyrics(), 50);
    this.timer = setInterval(() => {
      if (this.generation && this.valid() && this.loaded && !this.loading)
        this.report(this.guideBuffering || this.seekBuffering ? "buffering" : this.audio.paused ? "paused" : this.mediaState);
    }, 1000);
    window.addEventListener("pagehide", () => this.stop().catch(() => {}));
  }
  bindMedia(media) {
    media.addEventListener("seeked", () => {
      if (this.audio !== media || !this.seekApplying || !this.valid()) return;
      const seek = this.room?.current?.seek;
      if (seek?.id === this.seekApplying) {
        if (Math.abs(media.currentTime - seek.position) <= 0.25) {
          this.seekId = seek.id;
          this.seekBuffering = false;
        } else this.seekRejected = true;
      }
      this.seekApplying = null;
      this.update(this.room).catch(this.error);
    });
    for (const event of ["loadedmetadata", "durationchange", "progress", "canplay"])
      media.addEventListener(event, () => {
        if (this.audio === media && this.seekBuffering && this.valid())
          this.update(this.room).catch(this.error);
      });
    media.addEventListener("seeking", () => {
      if (this.audio === media) this.performanceTools?.staff?.reset();
    });
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
    this.referenceSnapshot = null;
    this.guideBuffering = false;
    this.seekId = null;
    this.seekCommandId = null;
    this.pendingSeek = null;
    this.seekBuffering = false;
    this.seekReloaded = false;
    this.seekApplying = null;
    this.seekRejected = false;
    const separation = this.separation;
    this.separation = null;
    clearTimeout(this.separationTimer);
    if (separation) this.services.request(`/api/rooms/${separation.roomId}/separation/${separation.id}/stop`,
      { method: "POST", body: {} }).catch(() => {});
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.audio = this.localMedia;
    this.song = null;
    this.guideNotes = [];
    if (this.localMedia.hidden !== undefined) this.localMedia.hidden = true;
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
        this.stop(`audio_context_${this.context.state}`).catch((error) => this.error(error));
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
      () => this.stop("lease_expired").catch((error) => this.error(error)),
      budget,
    );
  }
  async claim(roomId) {
    await this.initialize();
    this.roomId = roomId;
    const start = performance.now();
    const grant = await this.services.request(
      `/api/rooms/${roomId}/display/claim`,
      { method: "POST", body: {} },
    );
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
  async heartbeat() {
    const generation = this.generation;
    if (!generation || !this.connected) return;
    try {
      await this.renew();
      if (generation !== this.generation) return;
      // Network events remain active when background timer callbacks are delayed.
      if (this.separation && !this.separation.finishing &&
          (!this.referenceSnapshot?.complete || this.referenceSnapshot.mediaComplete === false || this.referenceSnapshot.lyricsPending)) {
        clearTimeout(this.separationTimer);
        await this.pollSeparation(this.loadingVersion, this.loaded);
      }
      if (this.room) await this.update(this.room);
    } catch (error) {
      if (generation !== this.generation) return;
      this.error(error);
      this.stop().catch(this.error);
    }
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
        const finish = () => this.services.request(`/api/rooms/${job.roomId}/separation/${job.id}`).then(snapshot => {
          if (this.separation !== job || this.loaded !== playbackId || !this.valid()) return;
          this.performanceTools?.updateLiveReference?.(snapshot);
          if (snapshot.complete === false) {
            this.separationTimer = setTimeout(finish, 1000);
            return;
          }
          job.finalized = true;
          this.report(state, playbackId);
        }).catch(error => {
          if (this.separation === job) this.failPlayback(error, playbackId);
        });
        finish();
      }
      return;
    }
    if (state === "ended" && this.endedPlaybackId !== playbackId) {
      this.endedPlaybackId = playbackId;
      this.resultsUntil = performance.now() + 5000;
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
      if (this.resultsUntil > performance.now()) {
        clearTimeout(this.resultsTimer);
        this.resultsTimer = setTimeout(() => this.update(this.room).catch(this.error), this.resultsUntil - performance.now());
        return;
      }
      const version = ++this.loadingVersion;
      this.loading = true;
      this.mediaState = "loading";
      this.loaded = playbackId;
      this.lines = [];
      this.clearMedia();
      this.report("loading", playbackId);
      try {
        const separated = await this.services.request(`/api/rooms/${room.id}/separation`,
          { method: "POST", body: { playbackId } });
        if (version !== this.loadingVersion || !this.valid()) {
          this.services.request(`/api/rooms/${room.id}/separation/${separated.id}/stop`, { method: "POST", body: {} }).catch(() => {});
          return;
        }
        this.separation = { id: separated.id, roomId: room.id };
        if (separated.ready === false) {
          this.separation.media = separated.media;
          this.pollSeparation(version, playbackId);
          return;
        }
        this.audio.src = separated.media;
        this.audio.hidden = false;
        this.song = { format: "youtube" };
        this.performanceTools?.beginLiveReference?.();
        this.lines = separated.lyrics?.lines || [];
        this.pollSeparation(version, playbackId);
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
    const seek = current.seek;
    if (seek && this.seekId !== seek.id) {
      if (this.seekCommandId !== seek.id) {
        this.seekCommandId = seek.id;
        this.seekRejected = false;
        // A seek may pause or reload media while play() is still pending.
        this.playAttempt = null;
      }
      if (this.seekApplying === seek.id) return;
      const waitForSeek = () => {
        const entering = !this.seekBuffering;
        this.seekBuffering = true;
        this.audio.pause();
        this.mediaState = "buffering";
        if (entering) this.report("buffering");
        // A response opened while the file was growing has no byte ranges.
        // Reopen it once finalized so the browser can read the MP4 seek index.
        if (this.referenceSnapshot?.mediaComplete && !this.seekReloaded) {
          this.seekReloaded = true;
          this.seekRejected = false;
          this.audio.load();
        }
      };
      // Some browsers reject a seek until the new media has metadata.
      if (this.audio.readyState === 0) {
        this.audio.pause();
        if (this.pendingSeek !== seek.id) {
          this.pendingSeek = seek.id;
          this.audio.addEventListener("loadedmetadata", () => {
            if (this.loaded === playbackId) this.update(this.room).catch(this.error);
          }, { once: true });
        }
        return;
      } else {
        const ranges = this.audio.seekable;
        const available = !this.seekRejected && (!ranges || Array.from({ length: ranges.length }, (_, i) => i)
          .some(i => seek.position >= ranges.start(i) && seek.position <= ranges.end(i)));
        if (!available) {
          waitForSeek();
          return;
        }
        this.seekApplying = seek.id;
        this.audio.currentTime = seek.position;
        if (this.audio.seeking) {
          this.seekBuffering = true;
          this.audio.pause();
          return;
        }
        this.seekApplying = null;
        // Do not consume a command the browser clamped back to the stream start.
        if (Math.abs(this.audio.currentTime - seek.position) > 0.25) {
          waitForSeek();
          return;
        }
        this.seekId = seek.id;
        this.seekBuffering = false;
      }
    }
    const reference = this.referenceSnapshot;
    if (reference && !reference.complete && Number.isFinite(reference.through)) {
      const ahead = reference.through - this.audio.currentTime;
      if (ahead < 7 || this.guideBuffering && ahead < 14) {
        const entering = !this.guideBuffering;
        this.guideBuffering = true;
        this.audio.pause();
        this.mediaState = "buffering";
        if (entering) this.report("buffering");
        return;
      }
    }
    this.guideBuffering = false;
    if (this.room.desired === "playing") {
      if (this.audio.paused && !this.audio.ended) {
        const generation = this.generation;
        const version = this.loadingVersion;
        const attempt = this.playAttempt = {};
        await this.audio.play().catch((error) => {
          if (error.name === "AbortError" && this.playAttempt !== attempt) return;
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
    if (!job || job.finishing || job.polling || version !== this.loadingVersion || !this.valid()) return;
    job.polling = true;
    try {
      const snapshot = await this.services.request(`/api/rooms/${job.roomId}/separation/${job.id}`);
      if (this.separation !== job || job.finishing || version !== this.loadingVersion || !this.valid()) return;
      this.referenceSnapshot = snapshot;
      this.performanceTools?.updateLiveReference?.(snapshot);
      if (snapshot.lyrics) this.lines = snapshot.lyrics.lines;
      if (this.loading && snapshot.ready) {
        this.audio.src = job.media;
        this.audio.hidden = false;
        this.song = { format: "youtube" };
        this.lines = snapshot.lyrics?.lines || [];
        this.performanceTools?.beginLiveReference?.();
        this.performanceTools?.updateLiveReference?.(snapshot);
        this.loading = false;
        this.mediaState = "ready";
        this.failedPlaybackId = null;
        await this.update(this.room);
      }
      if (!this.loading && (this.guideBuffering || this.seekBuffering)) await this.update(this.room);
      if (!snapshot.complete || snapshot.mediaComplete === false || this.loading || snapshot.lyricsPending) this.separationTimer = setTimeout(() => this.pollSeparation(version, playbackId), 1000);
    } catch (error) {
      if (this.separation === job && !job.finishing && version === this.loadingVersion) this.failPlayback(error, playbackId);
    } finally { job.polling = false; }
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
    if (this.referenceSnapshot && !this.referenceSnapshot.complete && !this.loading &&
        !this.audio.paused && this.referenceSnapshot.through - position < 7 && !this.guideBuffering)
      this.update(this.room).catch(this.error);
    this.performanceTools?.update(this);
    const index = (this.lines || []).findLastIndex(
      (line) => line.time <= position,
    );
    this.lyrics(
      index < 0 ? "" : position >= (this.lines[index].end ?? Infinity) ? "" : this.lines[index].text,
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
  async stop(reason = "stopped") {
    if (this.stopping) return this.stopping;
    if (this.generation) console.info("Karaoke display stopped", { reason });
    const generation = this.generation;
    this.generation = null;
    this.revalidated = false;
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
    if (!generation) return;
    this.stopping = (async () => {
      await this.context.suspend();
      try {
        await this.services.request(`/api/rooms/${this.roomId}/display/stop`, {
          method: "POST", keepalive: true, body: { generation },
        });
      } catch (error) {
        // Restarted/ended rooms need no release acknowledgment. A failed stop
        // expires through the heartbeat; there is no replacement display.
        if (![401, 404, 409].includes(error.status)) this.error(error);
      }
      this.released();
    })();
    try { await this.stopping; } finally { this.stopping = null; }
  }
}

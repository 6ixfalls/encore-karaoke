import { requestMicrophone } from "./microphone.js";

// Signaling stays on the authenticated room connection; audio travels over WebRTC.
export class RemoteMicrophone {
  constructor({ tv, status, level = () => {}, connections = () => {} }) {
    Object.assign(this, { tv, status, level, connections });
    this.peers = new Map();
    this.version = 0;
  }
  connect(socket, getRoom, player) {
    this.stop();
    Object.assign(this, { socket, getRoom, player });
    socket.on("mic:signal", (message) => this.receive(message).catch((error) => {
      this.stop(); this.status(error.message);
    }));
    socket.on("mic:closed", ({ from }) => this.closePeer(from));
    window.addEventListener("pagehide", () => this.stop(), { once: true });
  }
  signal(target, data) {
    return this.socket.emitWithAck("mic:signal", { target, ...data }).then((ack) => {
      if (!ack.accepted) throw new Error(ack.error || "Microphone connection unavailable");
    });
  }
  peer(id) {
    let entry = this.peers.get(id);
    if (entry) return entry;
    const pc = new RTCPeerConnection();
    entry = { pc, candidates: [] };
    this.peers.set(id, entry);
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.signal(id, { candidate: candidate.toJSON() }).catch(() => this.closePeer(id));
    };
    pc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
        this.closePeer(id);
        if (!this.tv) { this.stop(); this.status("Microphone disconnected. Enable it again to reconnect."); }
      } else if (pc.connectionState === "connected") {
        this.status("Microphone connected to the TV.");
        this.updateConnections();
      }
    };
    pc.ontrack = ({ track, streams }) => {
      if (this.peers.get(id) !== entry || !this.tv || track.kind !== "audio" || !this.player.valid()) return;
      this.player.performanceTools?.detachRemoteMicrophone(id);
      entry.source?.disconnect();
      this.player.mixer?.removeMicrophone?.(id);
      const stream = streams[0] || new MediaStream([track]);
      entry.source = this.player.context.createMediaStreamSource(stream);
      entry.source.connect(this.player.mixer?.microphoneInput(id) || this.player.gate);
      const nickname = this.getRoom?.()?.participants?.find(participant => participant.id === id)?.nickname;
      this.player.performanceTools?.attachRemoteMicrophone(id, entry.source, this.player.context, nickname);
      this.updateConnections();
      track.addEventListener?.("ended", () => { if (this.peers.get(id) === entry) this.closePeer(id); }, { once: true });
    };
    return entry;
  }
  async receive({ from, description, candidate }) {
    if (this.tv && !this.player.valid()) return;
    if (!this.tv && (!this.stream || from !== this.target)) return;
    const entry = this.peer(from), pc = entry.pc;
    if (description) {
      await pc.setRemoteDescription(description);
      for (const ice of entry.candidates.splice(0)) await pc.addIceCandidate(ice);
      if (description.type === "offer" && this.tv) {
        await pc.setLocalDescription(await pc.createAnswer());
        await this.signal(from, { description: pc.localDescription.toJSON() });
      }
    } else if (candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(candidate);
      else entry.candidates.push(candidate);
    }
  }
  async start() {
    this.stop();
    const version = this.version;
    const room = this.getRoom();
    if (!this.socket?.connected || !room?.lease || room.lease.retired || room.lease.releaseRequested)
      throw new Error("TV audio is not ready. Tap a TV control before enabling your microphone.");
    const stream = await requestMicrophone(false);
    if (version !== this.version) { stream.getTracks().forEach((track) => track.stop()); return false; }
    this.stream = stream;
    this.target = room.lease.deviceId;
    this.generation = room.lease.generation;
    try {
      const { pc } = this.peer(this.target);
      stream.getAudioTracks().forEach((track) => track.addEventListener?.("ended", () => {
        if (this.stream === stream) { this.stop(); this.status("Microphone disconnected. Enable it again to reconnect."); }
      }, { once: true }));
      this.startMeter(stream);
      for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
      await pc.setLocalDescription(await pc.createOffer());
      await this.signal(this.target, { description: pc.localDescription.toJSON() });
      this.status("Connecting microphone…");
      this.timeout = setTimeout(() => {
        if (pc.connectionState !== "connected") { this.stop(); this.status("Microphone could not reach the TV. Try using the same network."); }
      }, 15000);
      return true;
    } catch (error) { this.stop(); throw error; }
  }
  startMeter(stream) {
    const context = this.meterContext = new AudioContext();
    this.meterSource = context.createMediaStreamSource(stream);
    const analyser = this.meterAnalyser = context.createAnalyser();
    analyser.fftSize = 256;
    this.meterSource.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    context.resume().catch(() => {});
    const draw = () => {
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
      this.level(Math.min(1, rms * 4));
      this.meterFrame = requestAnimationFrame(draw);
    };
    draw();
  }
  updateConnections() {
    this.connections([...this.peers.values()].filter(({ pc, source }) => source && pc.connectionState === "connected").length);
  }
  update() {
    const room = this.getRoom?.();
    if (this.tv ? !this.player?.valid() : this.stream && (room?.lease?.generation !== this.generation || room?.lease?.retired || room?.lease?.releaseRequested || room?.status === "ended")) this.stop();
  }
  closePeer(id) {
    const entry = this.peers.get(id);
    if (!entry) return;
    this.peers.delete(id);
    this.player?.performanceTools?.detachRemoteMicrophone(id);
    entry.source?.disconnect();
    this.player?.mixer?.removeMicrophone?.(id);
    entry.pc.close();
    this.updateConnections();
  }
  stop() {
    this.version++;
    clearTimeout(this.timeout);
    if (this.meterFrame !== undefined) cancelAnimationFrame(this.meterFrame);
    this.meterFrame = undefined;
    this.meterSource?.disconnect(); this.meterAnalyser?.disconnect();
    this.meterContext?.close().catch(() => {});
    this.meterSource = this.meterAnalyser = this.meterContext = null;
    this.level(0);
    if (this.socket?.connected && (this.stream || this.peers.size)) this.socket.emit("mic:close", {});
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    for (const id of this.peers.keys()) this.closePeer(id);
    if (!this.tv) {
      const start = document.getElementById("remote-mic-start"), stop = document.getElementById("remote-mic-stop");
      if (start) start.hidden = false;
      if (stop) stop.hidden = true;
    }
  }
}

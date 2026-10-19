// Signaling stays on the authenticated room connection; audio travels over WebRTC.
export class RemoteMicrophone {
  constructor({ tv, status }) {
    Object.assign(this, { tv, status });
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
      } else if (pc.connectionState === "connected") this.status("Microphone connected to the TV.");
    };
    pc.ontrack = ({ track, streams }) => {
      if (!this.tv || track.kind !== "audio" || !this.player.valid()) return;
      const stream = streams[0] || new MediaStream([track]);
      entry.source = this.player.context.createMediaStreamSource(stream);
      entry.source.connect(this.player.gate);
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
      throw new Error("Start karaoke on the TV before enabling your microphone.");
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access requires HTTPS and a supported browser.");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (version !== this.version) { stream.getTracks().forEach((track) => track.stop()); return; }
    this.stream = stream;
    this.target = room.lease.deviceId;
    this.generation = room.lease.generation;
    const { pc } = this.peer(this.target);
    for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await this.signal(this.target, { description: pc.localDescription.toJSON() });
      this.status("Connecting microphone…");
      this.timeout = setTimeout(() => {
        if (pc.connectionState !== "connected") { this.stop(); this.status("Microphone could not reach the TV. Try using the same network."); }
      }, 15000);
    } catch (error) { this.stop(); throw error; }
  }
  update() {
    const room = this.getRoom?.();
    if (this.tv ? !this.player?.valid() : this.stream && (room?.lease?.generation !== this.generation || room?.lease?.retired || room?.lease?.releaseRequested || room?.status === "ended")) this.stop();
  }
  closePeer(id) {
    const entry = this.peers.get(id);
    if (!entry) return;
    this.peers.delete(id);
    entry.source?.disconnect();
    entry.pc.close();
  }
  stop() {
    this.version++;
    clearTimeout(this.timeout);
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

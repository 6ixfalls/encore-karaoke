import { test } from "node:test";
import assert from "node:assert/strict";
import { requestMicrophone } from "../../src/hosted/microphone.js";
import { RemoteMicrophone } from "../../src/hosted/remote-microphone.js";
import { lowLatencyDescription, tuneMicrophoneReceiver, preferOpus } from "../../src/hosted/microphone-latency.js";
import { audioLatencyStats } from "../../src/hosted/microphone-diagnostics.js";
import { defaults, validatePreferences } from "../../src/hosted/preferences.ts";

function fixture(t, capture) {
  const descriptors = Object.fromEntries(["navigator", "document", "isSecureContext"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperties(globalThis, {
    navigator: { configurable: true, value: { mediaDevices: { getUserMedia: capture } } },
    document: { configurable: true, value: { getElementById: () => null } },
    isSecureContext: { configurable: true, writable: true, value: true },
  });
  t.after(() => { for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  } });
}

test("microphone requests immediately from the click and preserves capture settings", async t => {
  const stream = {}, requests = [];
  fixture(t, constraints => { requests.push(constraints); return Promise.resolve(stream); });
  const pending = requestMicrophone();
  assert.equal(requests.length, 1);
  assert.equal(await pending, stream);
  await requestMicrophone(false);
  assert.equal(requests[0].audio.autoGainControl, true);
  assert.equal(requests[1].audio.autoGainControl, false);
  assert.equal(requests[0].video, false);
});

test("saved microphone denial gives recovery steps without retrying capture", async t => {
  let attempts = 0;
  fixture(t, async () => { attempts++; throw new DOMException("Permission denied", "NotAllowedError"); });
  await assert.rejects(requestMicrophone(), error => {
    assert.match(error.message, /Site settings → Microphone/);
    assert.match(error.message, /Settings → Apps → Permissions/);
    assert.equal(error.cause.name, "NotAllowedError");
    return true;
  });
  assert.equal(attempts, 1);
});

test("phone capture requests unprocessed mono audio without changing local capture", async t => {
  const requests = [];
  fixture(t, async constraints => { requests.push(constraints); return {}; });
  await requestMicrophone(false, true);
  await requestMicrophone(false);
  assert.deepEqual(requests[0], { audio: {
    echoCancellation: false, noiseSuppression: false, autoGainControl: false,
    channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 }, latency: { ideal: 0 },
  }, video: false });
  assert.deepEqual(requests[1].audio, { echoCancellation: true, noiseSuppression: true, autoGainControl: false });
});

test("Opus packet preferences preserve payload IDs, FEC and unrelated SDP sections", () => {
  const session = "v=0\r\ns=-\r\n";
  const audio = "m=audio 9 UDP/TLS/RTP/SAVPF 111 0\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\na=ptime:20\r\na=maxptime:60\r\n";
  const video = "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n";
  const description = { type: "answer", sdp: session + audio + video };
  const tuned = lowLatencyDescription(description);
  assert.equal(tuned.type, "answer");
  assert.equal(tuned.sdp, session + audio.replace("a=ptime:20", "a=ptime:10").replace("a=maxptime:60", "a=maxptime:10") + video);
  assert.deepEqual(lowLatencyDescription(tuned), tuned);
  const fallback = { type: "answer", sdp: "m=audio 9 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n" };
  assert.deepEqual(lowLatencyDescription(fallback), fallback);
});

test("receiver buffering hints tolerate unsupported and rejecting browsers", () => {
  const modern = { jitterBufferTarget: null, playoutDelayHint: null };
  tuneMicrophoneReceiver(modern);
  assert.equal(modern.jitterBufferTarget, 0);
  assert.equal(modern.playoutDelayHint, null);
  const legacy = { playoutDelayHint: null };
  tuneMicrophoneReceiver(legacy);
  assert.equal(legacy.playoutDelayHint, 0);
  tuneMicrophoneReceiver(legacy, null);
  assert.equal(legacy.playoutDelayHint, null);
  const unsupported = {};
  tuneMicrophoneReceiver(unsupported);
  assert.deepEqual(unsupported, {});
  assert.doesNotThrow(() => tuneMicrophoneReceiver({ set jitterBufferTarget(value) { throw new Error(String(value)); } }));
  assert.doesNotThrow(() => tuneMicrophoneReceiver());
});

test("Opus preference retains fallback codecs and tolerates unsupported preferences", t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "RTCRtpReceiver");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "RTCRtpReceiver", descriptor); else delete globalThis.RTCRtpReceiver;
  });
  const pcmu = { mimeType: "audio/PCMU" }, opus = { mimeType: "audio/opus" };
  globalThis.RTCRtpReceiver = { getCapabilities: () => ({ codecs: [pcmu, opus] }) };
  let preferred;
  preferOpus({ setCodecPreferences: codecs => { preferred = codecs; } });
  assert.deepEqual(preferred, [opus, pcmu]);
  assert.doesNotThrow(() => preferOpus({}));
  assert.doesNotThrow(() => preferOpus({ setCodecPreferences() { throw new Error("unsupported"); } }));
});

test("insecure contexts and page policy blocks are diagnosed before capture", async t => {
  let attempts = 0;
  fixture(t, async () => { attempts++; });
  globalThis.isSecureContext = false;
  await assert.rejects(requestMicrophone(), /trusted HTTPS/);
  globalThis.isSecureContext = true;
  document.featurePolicy = { allowsFeature: feature => feature !== "microphone" };
  await assert.rejects(requestMicrophone(), /Permissions-Policy blocks/);
  assert.equal(attempts, 0);
});

test("canceling during a microphone prompt stops the late stream", async t => {
  let resolve, stopped = 0;
  fixture(t, () => new Promise(done => { resolve = done; }));
  const mic = new RemoteMicrophone({ tv: false, status() {} });
  mic.socket = { connected: true };
  mic.getRoom = () => ({ lease: { deviceId: "tv", generation: "lease" } });
  const pending = mic.start();
  mic.stop();
  resolve({ getTracks: () => [{ stop() { stopped++; } }] });
  assert.equal(await pending, false);
  assert.equal(stopped, 1);
  assert.equal(mic.stream, null);
});

test("failed WebRTC setup releases an already granted microphone", async t => {
  let stopped = 0;
  fixture(t, async () => ({ getTracks: () => [{ stop() { stopped++; } }] }));
  const mic = new RemoteMicrophone({ tv: false, status() {} });
  mic.socket = { connected: true, emit() {} };
  mic.getRoom = () => ({ lease: { deviceId: "tv", generation: "lease" } });
  mic.peer = () => { throw new Error("WebRTC unavailable"); };
  await assert.rejects(mic.start(), /WebRTC unavailable/);
  assert.equal(stopped, 1);
  assert.equal(mic.stream, null);
});

test("TV counts only connected microphones with audio and removes closed peers", t => {
  fixture(t, async () => {});
  const counts = [], detached = [];
  const mic = new RemoteMicrophone({ tv: true, status() {}, connections: count => counts.push(count) });
  mic.player = { performanceTools: { detachRemoteMicrophone: id => detached.push(id) } };
  const peer = (state, source) => ({ pc: { connectionState: state, close() {} }, source });
  const source = { disconnect() {} };
  mic.peers.set("one", peer("connected", source));
  mic.peers.set("two", peer("connecting", source));
  mic.peers.set("three", peer("connected"));
  mic.updateConnections();
  assert.equal(counts.at(-1), 1);
  mic.peers.get("two").pc.connectionState = "connected";
  mic.updateConnections();
  assert.equal(counts.at(-1), 2);
  mic.closePeer("one");
  assert.equal(counts.at(-1), 1);
  mic.stop();
  assert.equal(counts.at(-1), 0);
  assert.deepEqual(detached, ["one", "two", "three"]);
});

test("phone volume meter reads live audio and releases its animation and context on stop", t => {
  fixture(t, async () => {});
  const keys = ["AudioContext", "requestAnimationFrame", "cancelAnimationFrame"];
  const descriptors = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  t.after(() => keys.forEach((key, i) => {
    if (descriptors[i]) Object.defineProperty(globalThis, key, descriptors[i]); else delete globalThis[key];
  }));
  let amplitude = .1, frame, canceled, closed = 0, disconnected = 0;
  const levels = [];
  const analyser = { getFloatTimeDomainData: samples => samples.fill(amplitude), disconnect() { disconnected++; } };
  globalThis.AudioContext = class {
    createMediaStreamSource() { return { connect() {}, disconnect() { disconnected++; } }; }
    createAnalyser() { return analyser; }
    resume() { return Promise.resolve(); }
    close() { closed++; return Promise.resolve(); }
  };
  globalThis.requestAnimationFrame = callback => { frame = callback; return 42; };
  globalThis.cancelAnimationFrame = id => { canceled = id; };
  const mic = new RemoteMicrophone({ tv: false, status() {}, level: value => levels.push(value) });
  mic.startMeter({});
  assert.ok(Math.abs(levels.at(-1) - .4) < .001);
  amplitude = .5;
  frame();
  assert.equal(levels.at(-1), 1);
  mic.stop();
  assert.equal(levels.at(-1), 0);
  assert.equal(canceled, 42);
  assert.equal(closed, 1);
  assert.equal(disconnected, 2);
});

test("received phone audio attaches to the display scorer with its participant label", t => {
  fixture(t, async () => {});
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "RTCPeerConnection", descriptor); else delete globalThis.RTCPeerConnection;
  });
  globalThis.RTCPeerConnection = class { connectionState = "connected"; close() {} };
  const attached = [], connected = [];
  const source = { connect: target => connected.push(target), disconnect() {} }, stream = {};
  let played = 0, paused = 0;
  const receivers = [];
  document.createElement = tag => {
    assert.equal(tag, "audio");
    const audio = { play() { played++; return Promise.resolve(); }, pause() { paused++; } };
    receivers.push(audio);
    return audio;
  };
  const context = { createMediaStreamSource: received => { assert.equal(received, stream); return source; } };
  const mic = new RemoteMicrophone({ tv: true, status() {} });
  mic.getRoom = () => ({ participants: [{ id: "phone", nickname: "Alex" }] });
  mic.player = { valid: () => true, context, gate: {}, performanceTools: {
    detachRemoteMicrophone() {}, attachRemoteMicrophone: (...args) => attached.push(args),
  } };
  const { pc } = mic.peer("phone");
  const receiver = { jitterBufferTarget: null };
  pc.ontrack({ track: { kind: "audio", addEventListener() {} }, streams: [stream], receiver });
  assert.equal(receiver.jitterBufferTarget, 0);
  assert.equal(connected[0], mic.player.gate);
  assert.deepEqual(attached[0], ["phone", source, context, "Alex"]);
  assert.equal(receivers[0].srcObject, stream);
  assert.equal(receivers[0].muted, true, "receiver cannot bypass the mixer or lease gate");
  assert.equal(played, 1);
  pc.ontrack({ track: { kind: "audio", addEventListener() {} }, streams: [stream] });
  assert.equal(receivers[0].srcObject, null, "replacement releases the previous renderer");
  assert.equal(paused, 1);
  assert.equal(played, 2);
  mic.closePeer("phone");
  assert.equal(receivers[1].srcObject, null);
  assert.equal(paused, 2);
});

test("display answer negotiates short packets before signaling the phone", async t => {
  fixture(t, async () => {});
  const mic = new RemoteMicrophone({ tv: true, status() {} });
  mic.player = { valid: () => true };
  const answer = { type: "answer", sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n" };
  let sent;
  const pc = {
    async setRemoteDescription(value) { this.remoteDescription = value; },
    async createAnswer() { return answer; },
    async setLocalDescription(value) { this.localDescription = { toJSON: () => value }; },
  };
  mic.peer = () => ({ pc, candidates: [] });
  mic.signal = async (target, data) => { sent = { target, ...data }; };
  await mic.receive({ from: "phone", description: { type: "offer", sdp: answer.sdp } });
  assert.equal(sent.target, "phone");
  assert.equal(sent.description.type, "answer");
  assert.match(sent.description.sdp, /a=ptime:10\r\na=maxptime:10\r\n/);
});

test("buffer choices update active receivers and can restore browser defaults", () => {
  const mic = new RemoteMicrophone({ tv: true, status() {} });
  const receiver = { jitterBufferTarget: 20 };
  mic.peers.set("phone", { receiver });
  for (const value of ["0", "10", "20", "40"]) {
    mic.setBufferTarget(value);
    assert.equal(receiver.jitterBufferTarget, Number(value));
  }
  mic.setBufferTarget("auto");
  assert.equal(receiver.jitterBufferTarget, null);
  mic.setBufferTarget("-1");
  assert.equal(receiver.jitterBufferTarget, null);
  assert.equal(validatePreferences({ phoneMicBuffer: "40", phoneMicLowLatency: false }).phoneMicBuffer, "40");
  assert.equal(validatePreferences({ phoneMicLowLatency: false }).phoneMicLowLatency, false);
  assert.equal(validatePreferences({ phoneMicBuffer: "bad" }).phoneMicBuffer, defaults.phoneMicBuffer);
});

test("audio diagnostics report measured buffer averages, loss and selected route without inventing missing values", () => {
  const stats = new Map([
    ["audio", { type: "inbound-rtp", kind: "audio", codecId: "codec", jitter: .004,
      jitterBufferDelay: 2, jitterBufferTargetDelay: 1, jitterBufferEmittedCount: 100,
      packetsReceived: 500, packetsLost: 3, concealedSamples: 24 }],
    ["video", { type: "inbound-rtp", kind: "video" }],
    ["codec", { mimeType: "audio/opus" }],
    ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
    ["pair", { type: "candidate-pair", currentRoundTripTime: .006, localCandidateId: "local", remoteCandidateId: "remote" }],
    ["local", { candidateType: "host" }],
    ["remote", { candidateType: "host" }],
  ]);
  assert.deepEqual(audioLatencyStats(stats), [{ codec: "audio/opus", jitterMs: 4,
    averageBufferMs: 20, averageTargetBufferMs: 10, packetsReceived: 500, packetsLost: 3,
    concealedSamples: 24, roundTripMs: 6, relayed: false }]);
  stats.set("local", { candidateType: "relay" });
  assert.equal(audioLatencyStats(stats)[0].relayed, true);
  const missing = audioLatencyStats(new Map([["audio", { type: "inbound-rtp", mediaType: "audio", jitterBufferEmittedCount: 0 }]]))[0];
  assert.equal(missing.averageBufferMs, null);
  assert.equal(missing.roundTripMs, null);
  assert.equal(missing.packetsLost, null);
  assert.equal(missing.relayed, null);
});

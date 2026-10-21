import { test } from "node:test";
import assert from "node:assert/strict";
import { requestMicrophone } from "../../src/hosted/microphone.js";
import { RemoteMicrophone } from "../../src/hosted/remote-microphone.js";

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
  const context = { createMediaStreamSource: received => { assert.equal(received, stream); return source; } };
  const mic = new RemoteMicrophone({ tv: true, status() {} });
  mic.getRoom = () => ({ participants: [{ id: "phone", nickname: "Alex" }] });
  mic.player = { valid: () => true, context, gate: {}, performanceTools: {
    detachRemoteMicrophone() {}, attachRemoteMicrophone: (...args) => attached.push(args),
  } };
  const { pc } = mic.peer("phone");
  pc.ontrack({ track: { kind: "audio", addEventListener() {} }, streams: [stream] });
  assert.equal(connected[0], mic.player.gate);
  assert.deepEqual(attached[0], ["phone", source, context, "Alex"]);
});

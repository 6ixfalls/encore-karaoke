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

import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserPlayer } from "../../src/hosted/player.js";

class AudioElement extends EventTarget {
  constructor() {
    super();
    this.currentTime = 0;
    this.paused = true;
    this.ended = false;
    this.playbackRate = 1;
    this.playCount = 0;
  }
  async play() {
    this.playCount++;
    this.paused = false;
    this.dispatchEvent(new Event("playing"));
  }
  pause() {
    const changed = !this.paused;
    this.paused = true;
    if (changed) this.dispatchEvent(new Event("pause"));
  }
  load() {
    this.currentTime = 0;
    this.ended = false;
  }
  removeAttribute(name) {
    if (name === "src") this.src = "";
  }
}
class Context extends EventTarget {
  constructor() {
    super();
    this.state = "running";
    this.currentTime = 100;
    this.outputLatency = 0.02;
    this.baseLatency = 0.01;
    this.destination = {};
    this.connections = [];
  }
  createGain() {
    const gain = {
      value: 1,
      events: [],
      cancelScheduledValues(time) {
        this.events.push({ type: "cancel", time });
      },
      setValueAtTime(value, time) {
        this.events.push({ type: "set", value, time });
      },
    };
    return {
      gain,
      connect: (node) => {
        this.connections.push(["gate", node]);
      },
    };
  }
  createMediaElementSource() {
    return {
      connect: (node) => {
        this.connections.push(["source", node]);
      },
    };
  }
  async resume() {
    this.state = "running";
    this.dispatchEvent(new Event("statechange"));
  }
  async suspend() {
    this.state = "suspended";
    this.dispatchEvent(new Event("statechange"));
  }
}
function fixture(t) {
  const original = {
    Audio: globalThis.Audio,
    AudioContext: globalThis.AudioContext,
    window: globalThis.window,
    document: globalThis.document,
  };
  Object.assign(globalThis, {
    Audio: AudioElement,
    AudioContext: Context,
    window: new EventTarget(),
    document: new EventTarget(),
  });
  const calls = [],
    reports = [],
    errors = [],
    rendered = [];
  const service = {
    request: async (...args) => {
      calls.push(args);
      return {};
    },
    media: (id) => `/media/${id}`,
  };
  const player = new BrowserPlayer(service, {
    telemetry: (report) => reports.push(report),
    lyrics: (...lines) => rendered.push(lines),
    error: (error) => errors.push(error),
    released: () => calls.push(["released"]),
  });
  player.connected = true;
  player.roomId = "room-1";
  const room = {
    id: "room-1",
    status: "open",
    volume: 0.5,
    tempo: 1,
    current: null,
    desired: "paused",
    lease: {
      generation: "generation-1",
      retired: false,
      releaseRequested: false,
    },
  };
  player.room = room;
  t.after(() => {
    clearInterval(player.timer);
    clearInterval(player.lyricsTimer);
    clearInterval(player.renewTimer);
    clearTimeout(player.expiryTimer);
    Object.assign(globalThis, original);
  });
  return { player, service, calls, reports, errors, rendered, room };
}
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test("fractional lyric transitions render between telemetry reports", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { player, service, room, reports, rendered } = fixture(t);
  await player.initialize();
  player.arm({ generation: "generation-1", leaseMs: 10_000 }, performance.now());
  service.request = async () => ({ assetId: "asset" });
  await player.update({ ...room, desired: "playing", current: { playbackId: "track", songId: "song" } });
  player.lines = [
    { time: 1.05, text: "First" },
    { time: 1.10, text: "Second" },
    { time: 1.15, text: "Third" },
  ];
  player.audio.currentTime = 1;
  t.mock.timers.tick(1000);
  const reportCount = reports.length;
  for (const [time, current, next] of [
    [1.05, "First", "Second"],
    [1.10, "Second", "Third"],
    [1.15, "Third", ""],
  ]) {
    player.audio.currentTime = time;
    t.mock.timers.tick(50);
    assert.deepEqual(rendered.at(-1), [current, next]);
    assert.equal(reports.length, reportCount);
  }
  t.mock.timers.tick(850);
  assert.equal(reports.length, reportCount + 1);
});

test("renewal failures stop only the generation that requested renewal", async t => {
  for (const replacement of [false, true]) {
    await t.test(replacement ? "replacement generation" : "current generation", async t => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const { player, service, room, errors } = fixture(t);
      let claimCount = 0, rejectRenewal, renewal;
      const pendingRenewal = new Promise((_, reject) => { rejectRenewal = reject; });
      service.request = async url => {
        if (url.endsWith("/display/renew")) return pendingRenewal;
        if (url.endsWith("/display/claim"))
          return { generation: `generation-${++claimCount}`, leaseMs: 10_000, releaseToken: "token" };
        if (url.startsWith("/display-release/")) return { ok: true };
        return { ...room, lease: { ...room.lease, generation: `generation-${claimCount}` } };
      };
      const renew = player.renew.bind(player);
      player.renew = () => { renewal = renew(); return renewal; };
      await player.claim(room.id);
      t.mock.timers.tick(2000);
      if (replacement) {
        await player.stop();
        await player.claim(room.id);
        assert.equal(player.generation, "generation-2");
      }
      const error = new Error("stale_display");
      rejectRenewal(error);
      await assert.rejects(renewal, /stale_display/);
      assert.equal(player.generation, replacement ? "generation-2" : null);
      assert.deepEqual(errors, replacement ? [] : [error]);
      if (replacement) assert.equal(player.valid(), true);
      if (player.stopping) await player.stopping;
    });
  }
});

test("periodic telemetry never confirms a song before playing and preserves buffering", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { player, service, room, reports } = fixture(t);
  await player.initialize();
  player.arm({ generation: "generation-1", leaseMs: 10_000 }, performance.now());
  service.request = async () => ({ assetId: "asset" });
  // play() clears paused before enough data arrives to emit playing.
  player.audio.play = async () => { player.audio.paused = false; };
  await player.update({ ...room, desired: "playing", current: { playbackId: "track", songId: "song" } });
  t.mock.timers.tick(1000);
  assert.equal(reports.some(r => r.state === "playing"), false);
  player.audio.dispatchEvent(new Event("waiting"));
  t.mock.timers.tick(1000);
  assert.equal(reports.at(-1).state, "buffering");
  player.audio.dispatchEvent(new Event("playing"));
  t.mock.timers.tick(1000);
  assert.equal(reports.at(-1).state, "playing");
});

test("a superseded play rejection cannot fail the replacement track or display", async t => {
  for (const replacement of ["track", "generation", "pause"]) {
    await t.test(replacement, async t => {
      const { player, service, room, reports, errors } = fixture(t);
      await player.initialize();
      player.arm({ generation: "generation-1", leaseMs: 10_000 }, performance.now());
      service.request = async () => ({ assetId: "asset" });
      let rejectPlay;
      const starting = deferred();
      player.audio.play = () => {
        player.audio.paused = false;
        starting.resolve();
        return new Promise((_, reject) => { rejectPlay = reject; });
      };
      const playing = { ...room, desired: "playing", current: { playbackId: "old", songId: "song" } };
      const pending = player.update(playing);
      await starting.promise;
      player.audio.play = AudioElement.prototype.play;
      if (replacement === "track") {
        await player.update({ ...playing, current: { playbackId: "new", songId: "next" } });
      } else if (replacement === "generation") {
        player.arm({ generation: "generation-2", leaseMs: 10_000 }, performance.now());
      } else {
        await player.update({ ...playing, desired: "paused" });
      }
      rejectPlay(new DOMException("Playback interrupted", "AbortError"));
      await pending;
      assert.equal(reports.some(report => report.state === "failed"), false);
      assert.deepEqual(errors, []);
      if (replacement === "track") {
        assert.equal(player.loaded, "new");
        assert.equal(player.audio.paused, false);
      }
    });
  }
});

test("a current play rejection still reports the failed track", async t => {
  const { player, service, room, reports, errors } = fixture(t);
  await player.initialize();
  player.arm({ generation: "generation-1", leaseMs: 10_000 }, performance.now());
  service.request = async () => ({ assetId: "asset" });
  const error = new Error("Playback unavailable");
  player.audio.play = async () => { throw error; };
  await player.update({ ...room, desired: "playing", current: { playbackId: "track", songId: "song" } });
  assert.deepEqual(errors, [error]);
  assert.equal(reports.at(-1).state, "failed");
  assert.equal(reports.at(-1).playbackId, "track");
  assert.equal(reports.at(-1).leaseGeneration, "generation-1");
});

test("a media error reloads the resource only after explicit resume", async t => {
  const { player, service, room, reports } = fixture(t);
  await player.initialize();
  player.arm({ generation: "generation-1", leaseMs: 10_000 }, performance.now());
  let lookups = 0;
  service.request = async () => { lookups++; return { assetId: "asset" }; };
  const playing = { ...room, revision: 1, desired: "playing", current: { playbackId: "track", songId: "song" } };
  await player.update(playing);
  player.audio.dispatchEvent(new Event("error"));
  assert.equal(reports.at(-1).state, "failed");
  assert.equal(reports.at(-1).playbackId, "track");
  assert.equal(player.audio.src, "");
  await player.update({ ...playing, revision: 2, desired: "paused" });
  assert.equal(lookups, 1);
  await player.update({ ...playing, revision: 3 });
  assert.equal(lookups, 2);
  assert.equal(player.audio.src, "/media/asset");
  assert.equal(player.audio.paused, false);
});

test("a media error during lyrics loading cancels the pending load", async t => {
  const { player, service, room, reports } = fixture(t);
  await player.initialize();
  player.arm({ generation: "generation-1", leaseMs: 10_000 }, performance.now());
  service.request = async () => ({ assetId: "asset", lyricsId: "lyrics" });
  const lyrics = deferred();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => lyrics.promise;
  t.after(() => { globalThis.fetch = originalFetch; });
  const pending = player.update({ ...room, desired: "playing", current: { playbackId: "track", songId: "song" } });
  await Promise.resolve();
  player.audio.dispatchEvent(new Event("error"));
  lyrics.resolve({ ok: true, text: async () => "[00:01]Line" });
  await pending;
  assert.equal(player.loaded, null);
  assert.equal(player.audio.paused, true);
  assert.equal(reports.at(-1).state, "failed");
});

test("output starts closed, every MP3 route uses the gate, and volume updates preserve its scheduled cutoff", async (t) => {
  const { player, room } = fixture(t);
  await player.initialize();
  assert.equal(player.gate.gain.value, 0);
  assert.deepEqual(player.context.connections, [
    ["source", player.gate],
    ["gate", player.context.destination],
  ]);
  player.arm(
    { generation: "generation-1", leaseMs: 10_000 },
    performance.now() - 200,
  );
  const initial = [...player.gate.gain.events];
  const cutoff = initial.at(-1);
  assert.equal(cutoff.value, 0);
  assert.ok(cutoff.time > 109 && cutoff.time < 110);
  await player.update({ ...room, volume: 0.8 });
  assert.equal(
    player.gate.gain.events.filter((e) => e.type === "cancel").length,
    1,
  );
  assert.ok(player.gate.gain.events.includes(cutoff));
  assert.equal(player.gate.gain.events.at(-1).value, 0.8);
});

test("a late renewal response cannot reopen output after disconnect", async (t) => {
  const { player, service } = fixture(t);
  await player.initialize();
  player.arm(
    { generation: "generation-1", leaseMs: 10_000 },
    performance.now(),
  );
  const renewal = deferred();
  service.request = () => renewal.promise;
  const pending = player.renew();
  player.disconnected();
  const afterDisconnect = player.gate.gain.events.length;
  renewal.resolve({ generation: "generation-1", leaseMs: 10_000 });
  await pending;
  assert.equal(player.gate.gain.events.length, afterDisconnect);
  assert.equal(player.gate.gain.events.at(-1).value, 0);
  assert.equal(player.valid(), false);
  assert.equal(player.audio.paused, true);
});

test("a delayed song lookup cannot play a superseded reservation", async (t) => {
  const { player, service, room } = fixture(t);
  await player.initialize();
  player.arm(
    { generation: "generation-1", leaseMs: 10_000 },
    performance.now(),
  );
  const old = deferred();
  service.request = async (url) =>
    url.includes("song-old") ? old.promise : { assetId: "new-asset" };
  const before = player.update({
    ...room,
    desired: "playing",
    current: { playbackId: "old", songId: "song-old" },
  });
  await player.update({
    ...room,
    desired: "playing",
    current: { playbackId: "new", songId: "song-new" },
  });
  old.resolve({ assetId: "old-asset" });
  await before;
  assert.equal(player.audio.src, "/media/new-asset");
  assert.equal(player.loaded, "new");
  assert.equal(player.audio.playCount, 1);
});

test("a failed next-song lookup clears old media and retries only on resume", async (t) => {
  const { player, service, room, reports } = fixture(t);
  await player.initialize();
  player.arm({ generation: "generation-1", leaseMs: 10_000 }, performance.now());
  service.request = async () => ({ assetId: "first-asset" });
  await player.update({
    ...room, revision: 1, desired: "playing",
    current: { playbackId: "first", songId: "first" },
  });
  const next = {
    ...room, revision: 2, desired: "playing",
    current: { playbackId: "second", songId: "second" },
  };
  service.request = async () => { throw new Error("temporary lookup failure"); };
  await player.update(next);
  assert.equal(player.audio.src, "");
  assert.equal(player.audio.paused, true);
  assert.equal(player.loaded, null);
  assert.equal(reports.at(-1).state, "failed");
  assert.equal(reports.at(-1).playbackId, "second");
  let retries = 0;
  service.request = async () => { retries++; return { assetId: "second-asset" }; };
  await player.update({ ...next, revision: 3, desired: "paused" });
  assert.equal(retries, 0);
  await player.update({ ...next, revision: 4 });
  assert.equal(retries, 1);
  assert.equal(player.audio.src, "/media/second-asset");
  assert.equal(player.audio.paused, false);
});

test("a stale track acknowledgment preserves playback but a stale lease retires it", async (t) => {
  const { player, service, room, reports, errors } = fixture(t);
  await player.initialize();
  player.arm({ generation: "generation-1", leaseMs: 10_000 }, performance.now());
  service.request = async () => ({ assetId: "asset" });
  const playing = {
    ...room, revision: 1, desired: "playing",
    current: { playbackId: "first", songId: "song" },
  };
  await player.update(playing);
  const oldReport = reports.at(-1);
  await player.update({
    ...playing, revision: 2,
    current: { playbackId: "second", songId: "song" },
  });
  await player.handleTelemetryAck(oldReport, { error: "stale_playback" });
  assert.equal(player.generation, "generation-1");
  assert.equal(player.loaded, "second");
  assert.equal(player.audio.paused, false);
  assert.equal(errors.length, 0);
  await player.handleTelemetryAck(reports.at(-1), { error: "stale_display" });
  assert.equal(player.generation, null);
  assert.equal(player.audio.paused, true);
  assert.equal(errors.at(-1).message, "stale_display");
});

test("an acknowledgment from an old generation cannot stop its replacement", async (t) => {
  const { player, errors } = fixture(t);
  await player.initialize();
  player.arm({ generation: "generation-2", leaseMs: 10_000 }, performance.now());
  await player.handleTelemetryAck(
    { leaseGeneration: "generation-1", playbackId: "old" },
    { error: "stale_display" },
  );
  assert.equal(player.generation, "generation-2");
  assert.equal(errors.length, 0);
});

test("an authorized reconnect snapshot stays silent until a new lease renewal is accepted", async t => {
  const { player, service, room } = fixture(t);
  await player.initialize(); player.arm({ generation: "generation-1", leaseMs: 10_000 }, performance.now());
  service.request = async url => url.includes("/renew") ? { generation: "generation-1", leaseMs: 10_000 } : { assetId: "asset" };
  const playing = { ...room, revision: 2, desired: "playing", current: { playbackId: "current", songId: "song" } };
  await player.update(playing); assert.equal(player.audio.playCount, 1);
  player.disconnected(); player.connected = true;
  await player.update(playing);
  assert.equal(player.audio.paused, true); assert.equal(player.gate.gain.events.at(-1).value, 0);
  await player.renew(); await player.update(playing);
  assert.equal(player.audio.playCount, 2);
  await player.update({ ...playing, revision: 3, desired: "paused" });
  await player.update(playing);
  assert.equal(player.audio.paused, true); assert.equal(player.room.revision, 3);
});

test("disconnecting during song loading permits a fresh load after authorized renewal", async t => {
  const { player, service, room } = fixture(t);
  await player.initialize(); player.arm({ generation: "generation-1", leaseMs: 10_000 }, performance.now());
  const lookup = deferred(); service.request = () => lookup.promise;
  const playing = { ...room, desired: "playing", current: { playbackId: "current", songId: "song" } };
  const old = player.update(playing); player.disconnected();
  lookup.resolve({ assetId: "old" }); await old;
  player.connected = true;
  service.request = async url => url.includes("/renew") ? { generation: "generation-1", leaseMs: 10_000 } : { assetId: "fresh" };
  await player.renew(); await player.update(playing);
  assert.equal(player.audio.src, "/media/fresh"); assert.equal(player.audio.playCount, 1);
});

test("release permanently retires output before acknowledgment and retries a failed release without reopening", async (t) => {
  const { player, service, calls } = fixture(t);
  await player.initialize();
  player.arm(
    { generation: "generation-1", leaseMs: 10_000 },
    performance.now(),
  );
  player.releaseToken = "secret";
  player.audio.paused = false;
  let attempted = false;
  service.request = async (url, options) => {
    attempted = true;
    assert.equal(player.generation, null);
    assert.equal(player.audio.paused, true);
    assert.equal(player.audio.src, "");
    assert.equal(player.gate.gain.events.at(-1).value, 0);
    assert.equal(player.context.state, "suspended");
    calls.push([url, options]);
    throw new Error("disconnected");
  };
  const stopping = player.stop();
  assert.equal(player.retired.has("generation-1"), true);
  assert.equal(attempted, false);
  await assert.rejects(stopping, /disconnected/);
  assert.equal(player.pendingRelease.generation, "generation-1");
  await player.context.resume();
  assert.throws(
    () =>
      player.arm(
        { generation: "generation-1", leaseMs: 10_000 },
        performance.now(),
      ),
    /stale_display/,
  );
  service.request = async () => ({ ok: true });
  await player.releasePending();
  assert.equal(player.pendingRelease, null);
  assert.deepEqual(calls.at(-1), ["released"]);
});

test("lease suspension never resumes a retired generation when the audio clock was stopped", async (t) => {
  const { player } = fixture(t);
  await player.initialize();
  player.arm(
    { generation: "generation-1", leaseMs: 10_000 },
    performance.now(),
  );
  player.releaseToken = "secret";
  await player.context.suspend();
  if (player.stopping) await player.stopping;
  await player.context.resume();
  assert.equal(player.context.currentTime, 100);
  assert.equal(player.generation, null);
  assert.equal(player.gate.gain.events.at(-1).value, 0);
  assert.throws(
    () =>
      player.arm(
        { generation: "generation-1", leaseMs: 10_000 },
        performance.now(),
      ),
    /stale_display/,
  );
});

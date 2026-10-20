import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserPlayer } from "../../src/hosted/player.js";
import { PerformanceTools } from "../../src/hosted/performance.js";

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
      return { id: "job", media: "/media/separation/job", complete: true };
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
    clearTimeout(player.separationTimer);
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
  service.request = async () => ({ id: "asset", media: "/media/asset", complete: true });
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
  service.request = async () => ({ id: "asset", media: "/media/asset", complete: true });
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
      service.request = async () => ({ id: "asset", media: "/media/asset", complete: true });
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
  service.request = async () => ({ id: "asset", media: "/media/asset", complete: true });
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
  service.request = async url => { if (url.endsWith("/separation")) lookups++; return { id: "asset", media: "/media/asset", complete: true }; };
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

test("a media error during separation startup cancels the pending stream", async t => {
  const { player, service, room, reports } = fixture(t);
  await player.initialize();
  player.arm({ generation: "generation-1", leaseMs: 10_000 }, performance.now());
  const separation = deferred();
  service.request = () => separation.promise;
  const pending = player.update({ ...room, desired: "playing", current: { playbackId: "track", songId: "song" } });
  player.audio.dispatchEvent(new Event("error"));
  separation.resolve({ id: "old-job", media: "/media/separation/old-job", complete: true });
  await pending;
  assert.equal(player.loaded, null);
  assert.equal(player.audio.paused, true);
  assert.equal(reports.at(-1).state, "failed");
});

test("output starts closed, YouTube output uses the gate, and volume updates preserve its scheduled cutoff", async (t) => {
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

test("a delayed separation cannot play a superseded reservation", async (t) => {
  const { player, service, room } = fixture(t);
  await player.initialize();
  player.arm(
    { generation: "generation-1", leaseMs: 10_000 },
    performance.now(),
  );
  const old = deferred();
  service.request = async (_url, options) =>
    options?.body?.playbackId === "old" ? old.promise : { id: "new-asset", media: "/media/new-asset", complete: true };
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
  old.resolve({ id: "old-asset", media: "/media/old-asset", complete: true });
  await before;
  assert.equal(player.audio.src, "/media/new-asset");
  assert.equal(player.loaded, "new");
  assert.equal(player.audio.playCount, 1);
});

test("a failed next-separation startup clears old media and retries only on resume", async (t) => {
  const { player, service, room, reports } = fixture(t);
  await player.initialize();
  player.arm({ generation: "generation-1", leaseMs: 10_000 }, performance.now());
  service.request = async () => ({ id: "first-asset", media: "/media/first-asset", complete: true });
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
  service.request = async url => { if (url.endsWith("/separation")) retries++; return { id: "second-asset", media: "/media/second-asset", complete: true }; };
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
  service.request = async () => ({ id: "asset", media: "/media/asset", complete: true });
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
  service.request = async url => url.includes("/renew") ? { generation: "generation-1", leaseMs: 10_000 } : { id: "asset", media: "/media/asset", complete: true };
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
  lookup.resolve({ id: "old", media: "/media/old", complete: true }); await old;
  player.connected = true;
  service.request = async url => url.includes("/renew") ? { generation: "generation-1", leaseMs: 10_000 } : { id: "fresh", media: "/media/fresh", complete: true };
  await player.renew(); await player.update(playing);
  assert.equal(player.audio.src, "/media/fresh"); assert.equal(player.audio.playCount, 1);
});

test("stopping mutes immediately even when the ephemeral server has gone away", async t => {
  const { player, service, calls } = fixture(t);
  await player.initialize();
  player.arm({ generation: "generation-1", leaseMs: 10_000 }, performance.now());
  player.audio.paused = false;
  service.request = async (url, options) => {
    assert.equal(player.generation, null);
    assert.equal(player.audio.paused, true);
    assert.equal(player.gate.gain.events.at(-1).value, 0);
    assert.equal(player.context.state, "suspended");
    assert.equal(url, "/api/rooms/room-1/display/stop");
    assert.equal(options.body.generation, "generation-1");
    throw Object.assign(new Error("room_not_found"), { status: 404 });
  };
  await player.stop();
  assert.equal(player.pendingRelease, undefined);
  assert.deepEqual(calls.at(-1), ["released"]);
  await player.context.resume();
  assert.throws(() => player.arm({ generation: "generation-1", leaseMs: 10000 }, performance.now()), /stale_display/);
});

test("lease suspension never resumes a retired generation when the audio clock was stopped", async (t) => {
  const { player } = fixture(t);
  await player.initialize();
  player.arm(
    { generation: "generation-1", leaseMs: 10_000 },
    performance.now(),
  );
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

test("YouTube streams use the native media element and the existing fenced audio graph", async t => {
  const { player, service, room } = fixture(t);
  await player.initialize();
  player.arm({ generation: "generation-1", leaseMs: 10000 }, performance.now());
  service.request = async (path) => path.endsWith("/separation") ?
      { id: "job", media: `/media/separation/job?roomId=${room.id}` } : { complete: true };
  await player.update({ ...room, desired: "playing", current: { playbackId: "video", songId: "yt:M7lc1UVf-VE" } });
  assert.equal(player.audio, player.localMedia);
  assert.equal(player.audio.hidden, false);
  assert.equal(player.audio.src, `/media/separation/job?roomId=${room.id}`);
  player.disconnected();
  assert.equal(player.audio.paused, true);
  assert.equal(player.gate.gain.events.at(-1).value, 0);
});

test("YouTube finalization retires progress polls before accepting the final reference", async t => {
  for (const outcome of ["older snapshot", "incomplete snapshot", "request failure"]) {
    await t.test(outcome, async t => {
      const { player, service, reports, errors } = fixture(t);
      await player.initialize();
      player.arm({ generation: "generation-1", leaseMs: 10000 }, performance.now());
      const tools = new PerformanceTools({ status() {}, score() {}, recording() {} });
      tools.beginLiveReference();
      player.performanceTools = tools;
      player.loaded = "video";
      player.separation = { id: "job", roomId: "room-1" };
      const snapshot = (through, complete) => ({ pitches: Array(100).fill(440),
        step: 1024 / 44100, through, singable: 2, complete });
      let resolvePoll, rejectPoll, requests = 0;
      service.request = () => ++requests === 1 ? new Promise((resolve, reject) => {
        resolvePoll = resolve;
        rejectPoll = reject;
      }) : Promise.resolve(snapshot(20, true));
      const polling = player.pollSeparation(player.loadingVersion, "video");
      player.report("ended");
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(reports.at(-1).state, "ended");

      if (outcome === "request failure") rejectPoll(new Error("network_error"));
      else resolvePoll(snapshot(outcome === "older snapshot" ? 16 : 20, false));
      await polling;
      await player.pollSeparation(player.loadingVersion, "video");

      assert.equal(requests, 2);
      assert.equal(tools.liveReference.through, 20);
      assert.equal(tools.liveReference.complete, true);
      assert.equal(player.loaded, "video");
      assert.deepEqual(errors, []);
      assert.deepEqual(reports.map(report => report.state), ["ended"]);
      assert.equal(player.separationTimer, undefined);
    });
  }
});

test("tab hiding does not stop playback; pause, seek and resume retain the loaded media", async t => {
  const { player, room, calls, rendered } = fixture(t);
  await player.initialize();
  player.arm({ generation: "generation-1", leaseMs: 10000 }, performance.now());
  const playing = { ...room, current: { playbackId: "track" }, desired: "playing" };
  await player.update(playing);
  player.audio.currentTime = 42.25;
  document.hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("blur"));
  assert.equal(player.audio.paused, false);
  assert.equal(player.generation, "generation-1");
  await player.update({ ...playing, desired: "paused" });
  assert.equal(player.audio.currentTime, 42.25);
  const seek = { ...playing, desired: "paused", current: { playbackId: "track", seek: { id: "seek-1", position: 12.5 } } };
  await player.update(seek);
  assert.equal(player.audio.currentTime, 12.5);
  assert.equal(player.audio.paused, true);
  player.lines = [{ time: 12, end: 13, text: "First" }, { time: 14, end: 15, text: "Next" }];
  player.renderLyrics();
  assert.deepEqual(rendered.at(-1), ["First", "Next"]);
  player.audio.currentTime = 13.5;
  player.renderLyrics();
  assert.deepEqual(rendered.at(-1), ["", "Next"]);
  await player.update({ ...seek, desired: "playing" });
  assert.equal(player.audio.currentTime, 13.5);
  assert.equal(player.audio.paused, false);
  assert.equal(calls.filter(([url, options]) => url.endsWith("/separation") && options?.method === "POST").length, 1);
});

test("reconnecting within the same lease reapplies the seek to reloaded media", async t => {
  const { player, room, calls } = fixture(t);
  await player.initialize();
  player.arm({ generation: "generation-1", leaseMs: 10000 }, performance.now());
  const snapshot = { ...room, desired: "playing", current: {
    playbackId: "track", seek: { id: "seek-1", position: 42.25 },
  } };
  await player.update(snapshot);
  assert.equal(player.audio.currentTime, 42.25);

  player.disconnected();
  assert.equal(player.audio.currentTime, 0);
  player.connected = true;
  player.arm({ generation: "generation-1", leaseMs: 10000 }, performance.now());
  await player.update(snapshot);

  assert.equal(player.audio.currentTime, 42.25);
  assert.equal(player.audio.paused, false);
  assert.equal(calls.filter(([url, options]) => url.endsWith("/separation") && options?.method === "POST").length, 2);
});

test("preparation honors a pause and seek issued before media becomes ready", async t => {
  const { player, room, service } = fixture(t);
  await player.initialize();
  player.arm({ generation: "generation-1", leaseMs: 10000 }, performance.now());
  service.request = async (_url, options) => options?.method === "POST"
    ? { id: "job", media: "/prepared", ready: false }
    : { ready: false, complete: false };
  const playing = { ...room, current: { playbackId: "track" }, desired: "playing" };
  await player.update(playing);
  assert.equal(player.loading, true);
  assert.equal(player.audio.playCount, 0);
  await player.update({ ...playing, desired: "paused", current: { playbackId: "track", seek: { id: "seek", position: 15 } } });
  clearTimeout(player.separationTimer);
  service.request = async () => ({ ready: true, complete: true, lyrics: { lines: [{ time: 15, end: 16, text: "Line" }] } });
  await player.pollSeparation(player.loadingVersion, "track");
  assert.equal(player.audio.src, "/prepared");
  assert.equal(player.audio.currentTime, 15);
  assert.equal(player.audio.paused, true);
  assert.equal(player.loading, false);
  assert.equal(player.lines[0].text, "Line");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { io } from "socket.io-client";
import { PassThrough } from "node:stream";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../dist/server/store.js";
import { createApplication } from "../../dist/server/app.js";
import { configuration } from "../../dist/server/config.js";

async function fixture(t) {
  const store = new Store(), config = configuration();
  const server = createApplication(store, config);
  await new Promise(resolve => server.http.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.http.address().port}`;
  config.origin = origin;
  t.after(() => server.close());
  async function request(route, { token, method = "GET", body, originHeader = origin } = {}) {
    const response = await fetch(origin + route, { method,
      headers: { Origin: originHeader, "Content-Type": "application/json", ...(token ? { "X-Participant-Token": token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  const launch = () => request("/api/launch", { method: "POST", body: {} });
  const tv = (await launch()).data;
  const pairing = (await request(`/api/rooms/${tv.roomId}/pairing`, { token: tv.token, method: "POST", body: {} })).data;
  const join = async (code = pairing.code) => (await request("/api/join", { method: "POST", body: { nickname: "Singer", invitation: code } })).data;
  const command = (member, type, payload = {}) => request(`/api/rooms/${tv.roomId}/commands`, { token: member.token, method: "POST", body: { commandId: randomUUID(), type, payload } });
  const connect = async (member) => {
    const socket = io(origin, { transports: ["websocket"], auth: { token: member.token }, extraHeaders: { Origin: origin }, reconnection: false });
    t.after(() => socket.disconnect());
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
    await socket.emitWithAck("room:subscribe", { roomId: tv.roomId });
    return socket;
  };
  return { server, store, config, origin, request, launch, tv, pairing, join, command, connect };
}

test("public launch and code/QR joining need no account or cookies", async t => {
  const f = await fixture(t);
  assert.equal(f.tv.role, "host"); assert.ok(f.tv.token);
  assert.match(f.pairing.qr, /^data:image\/png;base64,/);
  const url = new URL(f.pairing.url);
  assert.equal(url.pathname, "/control");
  const qrGuest = await f.join(new URLSearchParams(url.hash.slice(1)).get("invite"));
  const codeGuest = await f.join();
  assert.equal(qrGuest.roomId, f.tv.roomId); assert.equal(codeGuest.roomId, f.tv.roomId);
  assert.notEqual(codeGuest.token, f.tv.token);
  const session = await f.request("/api/session", { token: codeGuest.token });
  assert.equal(session.headers.get("set-cookie"), null);
  assert.equal(session.data.csrf, undefined);
  assert.equal(session.data.role, "guest");
  assert.equal((await f.request(`/api/rooms/${f.tv.roomId}`, { token: codeGuest.token })).data.canControl, true);
  assert.equal((await f.request("/readyz")).status, 200);
});

test("one main screen owns playback and there are no display invitations or admin/library APIs", async t => {
  const f = await fixture(t), guest = await f.join();
  const claim = (member) => f.request(`/api/rooms/${f.tv.roomId}/display/claim`, { token: member.token, method: "POST", body: {} });
  assert.equal((await claim(guest)).status, 403);
  assert.equal((await claim(f.tv)).status, 200);
  assert.equal((await claim(f.tv)).status, 409);
  assert.equal(f.store.get("rooms", f.tv.roomId).lease.releaseRequested, false);
  for (const route of ["/api/library/search", "/api/library/songs/anything", "/api/admin/library", `/api/rooms/${f.tv.roomId}/invitations`, "/api/rooms", "/api/login"]) {
    const response = await f.request(route, { token: f.tv.token, ...(route.endsWith("invitations") || route === "/api/rooms" || route === "/api/login" ? { method: "POST", body: {} } : {}) });
    assert.equal(response.status, 404, route);
  }
  assert.equal((await f.request("/media/anything", { token: f.tv.token })).status, 404);
});

test("three phone controllers share the queue through Socket.IO", async t => {
  const f = await fixture(t), guests = await Promise.all([f.join(), f.join(), f.join()]);
  const sockets = await Promise.all(guests.map(f.connect));
  const snapshots = sockets.map(socket => new Promise(resolve => socket.once("room:state", resolve)));
  const results = await Promise.all(sockets.map((socket, index) => socket.emitWithAck("room:command", {
    commandId: `queue-${index}`, type: "enqueue", payload: { youtube: "M7lc1UVf-VE", title: `Song ${index}` },
  })));
  assert.ok(results.every(ack => ack.accepted));
  await Promise.all(snapshots);
  for (const guest of guests) {
    const state = await f.request(`/api/rooms/${f.tv.roomId}`, { token: guest.token });
    assert.equal(state.data.queue.length, 3);
    assert.equal(state.data.participants.length, 4);
  }
});

test("room membership, Origin checks and removal scope controller access", async t => {
  const f = await fixture(t), guest = await f.join(), socket = await f.connect(guest);
  const other = (await f.launch()).data;
  assert.notEqual(other.roomId, f.tv.roomId);
  assert.equal((await f.request(`/api/rooms/${other.roomId}`, { token: guest.token })).status, 403);
  assert.equal((await f.request(`/api/rooms/${f.tv.roomId}`)).status, 401);
  assert.equal((await f.request("/api/launch", { method: "POST", body: {}, originHeader: "https://example.com" })).status, 403);
  const removed = new Promise(resolve => socket.once("session:revoked", resolve));
  assert.equal((await f.command(f.tv, "revoke", { deviceId: guest.id })).status, 200);
  await removed;
  assert.equal((await f.request("/api/session", { token: guest.token })).status, 401);
});

test("end invalidates the code, disconnects controllers and a new launch creates a new room", async t => {
  const f = await fixture(t), guest = await f.join(), socket = await f.connect(guest);
  const disconnected = new Promise(resolve => socket.once("disconnect", resolve));
  assert.equal((await f.command(f.tv, "end")).status, 200);
  await disconnected;
  assert.equal((await f.request("/api/join", { method: "POST", body: { nickname: "Late", invitation: f.pairing.code } })).status, 403);
  const next = await f.request("/api/launch", { token: f.tv.token, method: "POST", body: {} });
  assert.notEqual(next.data.roomId, f.tv.roomId);
});

test("search metadata survives sweeps until selection and expires when unused", async t => {
  const f = await fixture(t), guest = await f.join();
  const videoId = "M7lc1UVf-VE", unusedId = "abcdefghijk";
  f.server.youtube.search = async () => [{ videoId, title: "Song", artist: "Artist", duration: 195 }];
  f.server.youtube.metadata = async () => ({ videoId: unusedId, title: "Unused", artist: "Artist", duration: 120 });
  await f.request(`/api/youtube/search?roomId=${f.tv.roomId}&q=Song`, { token: guest.token });
  await f.request(`/api/youtube/${unusedId}/metadata?roomId=${f.tv.roomId}`, { token: guest.token });
  const expired = f.store.get("songs", `yt:${unusedId}`);
  f.store.put("songs", expired.id, { ...expired, metadataExpires: Date.now() - 1 });
  // Let the application's one-second cleanup run before selecting a result.
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(f.store.get("songs", `yt:${unusedId}`), undefined);
  assert.equal(f.store.get("songs", `yt:${videoId}`).duration, 195);
  await f.request(`/api/rooms/${f.tv.roomId}/display/claim`, { token: f.tv.token, method: "POST", body: {} });
  await f.command(guest, "enqueue", { youtube: videoId, title: "Song", artist: "Artist" });
  await f.command(guest, "play");
  const snapshot = await f.request(`/api/rooms/${f.tv.roomId}`, { token: guest.token });
  assert.equal(snapshot.data.duration, 195);
  assert.equal((await f.command(guest, "seek", { position: 196 })).data.accepted, false);
  assert.equal(f.store.get("songs", `yt:${videoId}`).metadataExpires, undefined);
});

test("YouTube search uses yt-dlp and separation streams belong exclusively to the main screen", async t => {
  const f = await fixture(t), guest = await f.join();
  f.server.youtube.search = async q => [{ videoId: "M7lc1UVf-VE", title: q, artist: "YouTube" }];
  const search = await f.request(`/api/youtube/search?roomId=${f.tv.roomId}&q=Karaoke`, { token: guest.token });
  assert.equal(search.data.items[0].title, "Karaoke");
  await f.request(`/api/rooms/${f.tv.roomId}/display/claim`, { token: f.tv.token, method: "POST", body: {} });
  await f.command(guest, "enqueue", { youtube: "M7lc1UVf-VE", title: "Song" });
  await f.command(guest, "play");
  const playbackId = f.store.get("rooms", f.tv.roomId).current.playbackId;
  const route = `/api/rooms/${f.tv.roomId}/separation`;
  assert.equal((await f.request(route, { token: guest.token, method: "POST", body: { playbackId } })).status, 403);
  f.server.separations.create = async (roomId, track, deviceId, _videoId, current) => {
    const output = new PassThrough();
    const directory = mkdtempSync(join(tmpdir(), "encore-test-")), file = join(directory, "backing.mp4");
    writeFileSync(file, "instrumental");
    const job = { id: "job", directory, file, writer: { bytesWritten: 12, writableFinished: true, destroy() {} }, referenceComplete: true, ready: true, roomId, playbackId: track, deviceId, current, output, controller: new AbortController(), processes: [], claimed: false, state: "processing", frames: { samples: 44100 * 20, snapshot: () => ({ pitches: [], through: 20 }) } };
    f.server.separations.jobs.set(job.id, job); return job;
  };
  const job = await f.request(route, { token: f.tv.token, method: "POST", body: { playbackId } });
  assert.equal(job.status, 201);
  const snapshot = await f.request(`${route}/job`, { token: f.tv.token });
  assert.equal(snapshot.data.mediaComplete, true);
  const url = new URL(job.data.media, f.origin);
  assert.equal(url.searchParams.get("participant"), f.tv.token);
  const foreign = new URL(url); foreign.searchParams.set("participant", guest.token);
  assert.equal((await fetch(foreign)).status, 404);
  const response = await fetch(url);
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.equal(await response.text(), "instrumental");
  const partial = await fetch(url, { headers: { Range: "bytes=2-5" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("accept-ranges"), "bytes");
  assert.equal(partial.headers.get("content-range"), "bytes 2-5/12");
  assert.equal(await partial.text(), "stru");
  assert.equal((await fetch(url, { method: "HEAD" })).headers.get("content-length"), "12");
  assert.equal(await (await fetch(url)).text(), "instrumental");
});

test("key transposition obeys room control policy and romanization requires the screen owner", async t => {
  const f = await fixture(t), guest = await f.join();
  assert.equal((await f.command(guest, "transpose", { value: 3 })).status, 200);
  assert.equal((await f.request(`/api/rooms/${f.tv.roomId}`, { token: guest.token })).data.transpose, 3);
  for (const value of [13, -13, 1.5, "3", null]) assert.equal((await f.command(guest, "transpose", { value })).status, 400);
  await f.command(f.tv, "policy", { guestCap: 5, roomCap: 100, guestControl: false });
  assert.equal((await f.command(guest, "transpose", { value: 0 })).status, 403);
  assert.equal((await f.request(`/api/rooms/${f.tv.roomId}/romanize`, { token: guest.token,
    method: "POST", body: { text: "日本語" } })).status, 403);
  assert.equal((await f.request(`/api/rooms/${f.tv.roomId}/romanize`, { token: f.tv.token,
    method: "POST", body: { text: "a".repeat(1001) } })).status, 400);
});

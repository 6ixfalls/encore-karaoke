import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once, EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer } from "node:http";
import { io } from "socket.io-client";
import { Store } from "../../dist/server/store.js";
import { createApplication } from "../../dist/server/app.js";
import { configuration } from "../../dist/server/config.js";

async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "encore-http-"));
  const library = path.join(directory, "library");
  await fs.mkdir(library);
  await fs.writeFile(
    path.join(library, "Artist - <img onerror=alert(1)>.mp3"),
    Buffer.from("0123456789"),
  );
  await fs.writeFile(
    path.join(library, "Artist - <img onerror=alert(1)>.lrc"),
    "[00:00.00]<script>window.injected=true</script>",
  );
  await fs.writeFile(path.join(directory, "private.mp3"), "private");
  await fs.symlink(
    path.join(directory, "private.mp3"),
    path.join(library, "escape.mp3"),
  );
  const store = new Store(path.join(directory, "data"));
  const config = {
    origin: "http://localhost",
    secure: false,
    library,
    web: path.resolve("dist/web"),
    maxTransfers: 2,
    ...overrides,
  };
  const server = createApplication(store, config);
  await server.library.scan();
  server.http.listen(0, "127.0.0.1");
  await once(server.http, "listening");
  config.origin = `http://127.0.0.1:${server.http.address().port}`;
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    await server.close();
    await fs.rm(directory, { force: true, recursive: true });
  });
  async function request(
    url,
    {
      session,
      method = "GET",
      body,
      headers = {},
      origin = config.origin,
    } = {},
  ) {
    const response = await fetch(`${config.origin}${url}`, {
      method,
      headers: {
        ...(session
          ? { Cookie: session.cookie, "X-CSRF-Token": session.csrf }
          : {}),
        ...(method !== "GET" ? { Origin: origin } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = response.headers
      .get("content-type")
      ?.includes("application/json")
      ? await response.json()
      : await response.text();
    return { response, data };
  }
  async function login(role = "admin") {
    const created = server.auth.create(role, role);
    return { ...created.session, cookie: created.cookie.split(";")[0] };
  }

  async function connect(session, origin = config.origin) {
    const socket = io(config.origin, {
      transports: ["websocket"],
      reconnection: false,
      timeout: 1000,
      auth: { csrf: session.csrf },
      extraHeaders: { Cookie: session.cookie, Origin: origin },
    });
    sockets.push(socket);
    await once(socket, "connect");
    return socket;
  }
  const admin = await login();
  const { data: room } = await request("/api/rooms", {
    session: admin,
    method: "POST",
    body: { name: "<b>Room</b>" },
  });
  const invitation = async (kind) =>
    (
      await request(`/api/rooms/${room.id}/invitations`, {
        session: admin,
        method: "POST",
        body: { kind },
      })
    ).data;
  async function guest(existingGrant) {
    const grant = existingGrant || (await invitation("guest"));
    const { response, data } = await request("/api/join", {
      method: "POST",
      body: { invitation: grant.code, nickname: "<img onerror=alert(1)>" },
    });
    assert.equal(response.status, 200);
    return {
      ...data,
      cookie: response.headers.get("set-cookie").split(";")[0],
    };
  }
  return {
    directory,
    library,
    store,
    server,
    config,
    request,
    login,
    connect,
    admin,
    room,
    invitation,
    guest,
  };
}

test("YouTube proxy enforces room access and forwards byte ranges and HEAD without exposing upstream URLs", async t => {
  const calls = [];
  const upstream = createServer((req, res) => {
    calls.push(req.url);
    assert.equal(req.headers.cookie, undefined);
    if (req.url.startsWith("/api/v1/videos/")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ formatStreams: [{ itag: "18", type: "video/mp4" }] }));
    } else if (req.url.startsWith("/latest_version")) {
      res.writeHead(302, { Location: "/videoplayback" }).end();
    } else {
      res.writeHead(req.headers.range ? 206 : 200, {
        "Content-Type": "video/mp4", "Content-Length": "4", "Accept-Ranges": "bytes",
        ...(req.headers.range ? { "Content-Range": "bytes 2-5/10" } : {}),
      });
      res.end("2345");
    }
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const f = await fixture(t);
  f.server.youtube.stream = async (_id, range, signal, head) => {
    if (range && !/^bytes=(\d*)-(\d*)$/.test(range)) return new Response(null, { status: 416 });
    return fetch(`http://127.0.0.1:${upstream.address().port}/videoplayback`, {
      signal, method: head ? "HEAD" : "GET", headers: range ? { Range: range } : {},
    });
  };
  const guest = await f.guest();
  const route = `/media/youtube/M7lc1UVf-VE?roomId=${f.room.id}`;
  assert.equal((await f.request(route)).response.status, 401);
  assert.equal((await f.request(route, { session: await f.login("host") })).response.status, 403);
  assert.equal(calls.length, 0);
  const result = await f.request(route, { session: guest, headers: { Range: "bytes=2-5" } });
  assert.equal(result.response.status, 206);
  assert.equal(result.response.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(result.response.headers.get("location"), null);
  assert.equal(result.data, "2345");
  assert.equal((await f.request(route, { session: guest, method: "HEAD" })).response.status, 200);
  assert.equal((await f.request(route, { session: guest, headers: { Range: "bytes=1-2,3-4" } })).response.status, 416);
});

test("vocal references are authorized sidecars, not songbook entries, and can match a YouTube ID", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.library, "Artist - Guide.mp3"), "music");
  await fs.writeFile(path.join(f.library, "Artist - Guide.vocals.wav"), "voice");
  await fs.writeFile(path.join(f.library, "M7lc1UVf-VE.vocals.wav"), "youtube voice");
  f.store.put("songs", "yt:M7lc1UVf-VE", { id: "yt:M7lc1UVf-VE", title: "Song", artist: "YouTube", format: "youtube", videoId: "M7lc1UVf-VE" });
  await f.server.library.scan();
  assert.equal(f.server.library.search("").total, 2);
  const local = f.store.all("songs").find(song => song.title === "Guide");
  assert.ok(local.referenceId);
  const route = id => `/api/library/songs/${id}?roomId=${f.room.id}`;
  assert.equal((await f.request(route(local.id))).response.status, 401);
  const guest = await f.guest();
  const localResult = await f.request(route(local.id), { session: guest });
  assert.ok(localResult.data.referenceVersion);
  const result = await f.request(route("yt:M7lc1UVf-VE"), { session: guest });
  assert.ok(result.data.referenceId);
  const reference = await f.request(`/media/${result.data.referenceId}?roomId=${f.room.id}`, { session: guest });
  assert.equal(reference.data, "youtube voice");
  assert.equal(f.server.library.vocalReference("m7lc1UVf-VE"), undefined);
});

test("live separation is scoped to the active display and playback, and streams the processed mux", async t => {
  const f = await fixture(t), guest = await f.guest(), children = [];
  f.server.youtube.resolve = async () => ({ url: "https://rr1.googlevideo.com/video", duration: 20, userAgent: "test" });
  f.server.separations.launch = () => {
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      stdio: [null, null, null, new PassThrough()], kill() { this.killed = true; } });
    children.push(child); return child;
  };
  f.server.rooms.command(f.room.id, f.admin, { commandId: "queue-live", type: "enqueue", payload: { youtube: "M7lc1UVf-VE", title: "Live" } });
  f.server.rooms.claim(f.room.id, f.admin);
  f.server.rooms.command(f.room.id, f.admin, { commandId: "play-live", type: "play" });
  const playbackId = f.store.get("rooms", f.room.id).current.playbackId;
  const route = `/api/rooms/${f.room.id}/separation`;
  assert.equal((await f.request(route, { session: guest, method: "POST", body: { playbackId } })).response.status, 403);
  assert.equal((await f.request(route, { session: f.admin, method: "POST", body: { playbackId: "old" } })).response.status, 409);
  assert.equal(children.length, 0);
  const result = await f.request(route, { session: f.admin, method: "POST", body: { playbackId } });
  assert.equal(result.response.status, 201);
  assert.equal(children.length, 3);
  const id = result.data.id;
  assert.equal((await f.request(`${route}/${id}`, { session: guest })).response.status, 404);
  assert.equal((await f.request(`${route}/${id}/stop`, { session: guest, method: "POST", body: {} })).response.status, 404);
  const progress = await f.request(`${route}/${id}`, { session: f.admin });
  assert.equal(progress.data.complete, false);
  assert.equal(progress.data.through, 0);
  const head = await f.request(result.data.media, { session: f.admin, method: "HEAD" });
  assert.equal(head.response.status, 200);
  assert.equal(f.server.separations.jobs.get(id).claimed, false);
  const stream = f.request(result.data.media, { session: f.admin });
  setTimeout(() => children[2].stdout.end("processed-video"), 10);
  const media = await stream;
  assert.equal(media.data, "processed-video");
  assert.equal(media.response.headers.get("accept-ranges"), "none");
  assert.equal((await f.request(`${route}/${id}/stop`, { session: f.admin, method: "POST", body: {} })).response.status, 200);
  assert.ok(children.every(child => child.killed));
});

test("headless HTTP serves authenticated opaque assets with ranges, validators, and safe indexing", async (t) => {
  const f = await fixture(t),
    guest = await f.guest();
  let result = await f.request(`/api/library/search?roomId=${f.room.id}`);
  assert.equal(result.response.status, 401);
  result = await f.request(`/api/library/search?roomId=${f.room.id}`, {
    session: guest,
  });
  assert.equal(result.data.total, 1); // symlink escape is excluded
  const song = result.data.items[0];
  assert.equal(song.title, "<img onerror=alert(1)>");
  assert.equal("relative" in song, false);
  assert.equal("path" in song, false);
  const media = `/media/${song.assetId}?roomId=${f.room.id}`;
  assert.equal((await f.request(media)).response.status, 401);
  result = await f.request(media, {
    session: guest,
    headers: { Range: "bytes=2-5" },
  });
  assert.equal(result.response.status, 206);
  assert.equal(result.data, "2345");
  assert.equal(result.response.headers.get("content-range"), "bytes 2-5/10");
  const etag = result.response.headers.get("etag");
  assert.equal(
    (
      await f.request(media, {
        session: guest,
        headers: { "If-None-Match": etag },
      })
    ).response.status,
    304,
  );
  assert.equal(
    (
      await f.request(media, {
        session: guest,
        headers: { Range: "bytes=99-" },
      })
    ).response.status,
    416,
  );
  result = await f.request(media, {
    session: guest,
    headers: { Range: "bytes=-3" },
  });
  assert.equal(result.data, "789");
  assert.equal(
    (
      await f.request(`/media/../../private.mp3?roomId=${f.room.id}`, {
        session: guest,
      })
    ).response.status,
    404,
  );
  assert.equal(
    (await f.request("/getFile?path=/etc/passwd", { session: guest })).response
      .status,
    404,
  );
  assert.equal(
    (await f.request("/drives", { session: guest })).response.status,
    404,
  );
  // Changing an indexed target into an outside symlink is checked again on every request.
  const record = f.store.get("assets", song.assetId);
  await fs.unlink(path.join(f.library, record.relative));
  await fs.symlink(
    path.join(f.directory, "private.mp3"),
    path.join(f.library, record.relative),
  );
  assert.equal(
    (await f.request(media, { session: guest })).response.status,
    403,
  );
});

test("HTTP origin, CSRF, room membership, and administrator boundaries", async (t) => {
  const f = await fixture(t),
    guest = await f.guest();
  const create = (session, extra = {}) =>
    f.request("/api/rooms", {
      session,
      method: "POST",
      body: { name: "Other" },
      ...extra,
    });
  assert.equal(
    (await create(f.admin, { origin: "https://evil.example" })).response.status,
    403,
  );
  assert.equal(
    (await create(f.admin, { headers: { "X-CSRF-Token": "wrong" } })).response
      .status,
    403,
  );
  assert.equal((await create(guest)).response.status, 403);
  const other = (await create(f.admin)).data;
  assert.equal(
    (await f.request(`/api/rooms/${other.id}`, { session: guest })).response
      .status,
    403,
  );
  assert.equal(
    (
      await f.request(`/api/library/search?roomId=${other.id}`, {
        session: guest,
      })
    ).response.status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/admin/library/rescan", {
        session: guest,
        method: "POST",
        body: {},
      })
    ).response.status,
    403,
  );
  assert.equal(
    (
      await f.request(`/api/admin/rooms/${f.room.id}/retire`, {
        session: await f.login("host"),
        method: "POST",
        body: {},
      })
    ).response.status,
    403,
  );
  const s = await f.request("/api/session", { session: f.admin });
  assert.match(
    s.response.headers.get("content-security-policy"),
    /script-src 'self'/,
  );
  assert.equal(s.response.headers.get("referrer-policy"), "no-referrer");
});

test("three concurrent controllers share serialized queue, retry identity, reconnect state, and revocation", async (t) => {
  const f = await fixture(t),
    invitation = await f.invitation("guest"),
    guests = await Promise.all([
      f.guest(invitation),
      f.guest(invitation),
      f.guest(invitation),
    ]);
  const sockets = await Promise.all(guests.map((g) => f.connect(g)));
  for (const socket of sockets) {
    const snapshot = await socket.emitWithAck("room:subscribe", {
      roomId: f.room.id,
    });
    assert.equal(snapshot.id, f.room.id);
  }
  const songId = f.store.all("songs")[0].id;
  const results = await Promise.all(
    sockets.map((socket, index) =>
      socket.emitWithAck("room:command", {
        commandId: `concurrent-${index}`,
        type: "enqueue",
        payload: { songId },
      }),
    ),
  );
  assert.ok(results.every((r) => r.accepted));
  const revisions = results.map((r) => r.revision);
  assert.equal(new Set(revisions).size, 3);
  assert.equal(f.store.get("rooms", f.room.id).queue.length, 3);
  const retry = {
    commandId: "concurrent-0",
    type: "enqueue",
    payload: { songId },
  };
  sockets[0].disconnect();
  const reconnected = await f.connect(guests[0]);
  assert.equal(
    (await reconnected.emitWithAck("room:subscribe", { roomId: f.room.id }))
      .queue.length,
    3,
  );
  assert.deepEqual(
    await reconnected.emitWithAck("room:command", retry),
    results[0],
  );
  await f.request(`/api/rooms/${f.room.id}/commands`, {
    session: f.admin, method: "POST",
    body: { commandId: "cap", type: "policy", payload: { roomCap: 4 } },
  });
  const beforeOverflow = f.store.get("rooms", f.room.id).revision;
  const overflow = await Promise.all([reconnected, sockets[1], sockets[2]].flatMap((socket, i) =>
    [0, 1].map(n => socket.emitWithAck("room:command", { commandId: `overflow-${i}-${n}`, type: "enqueue", payload: { songId } })),
  ));
  assert.equal(overflow.filter(ack => ack.accepted).length, 1);
  assert.equal(overflow.filter(ack => ack.error === "queue_full").length, 5);
  assert.equal(f.store.get("rooms", f.room.id).queue.length, 4);
  assert.equal(f.store.get("rooms", f.room.id).revision, beforeOverflow + 1);
  const denied = await sockets[1].emitWithAck("room:command", {
    commandId: "forbidden",
    type: "play",
  });
  assert.equal(denied.error, "forbidden");
  assert.equal(
    (await sockets[1].emitWithAck("mic:signal", {})).error,
    "display_unavailable",
  );
  await f.request(`/api/rooms/${f.room.id}/commands`, {
    session: f.admin,
    method: "POST",
    body: {
      commandId: "revoke",
      type: "revoke",
      payload: { deviceId: guests[0].id },
    },
  });
  assert.equal(
    (await f.request(`/api/rooms/${f.room.id}`, { session: guests[0] }))
      .response.status,
    401,
  );
  const badSocket = io(f.config.origin, {
    transports: ["websocket"],
    reconnection: false,
    auth: { csrf: guests[1].csrf },
    extraHeaders: { Cookie: guests[1].cookie, Origin: "https://evil.example" },
  });
  const error = await once(badSocket, "connect_error");
  assert.ok(error[0]);
  badSocket.disconnect();
});

test("HTTP rate limits use 429 and retain unchanged queue revisions", async (t) => {
  const f = await fixture(t),
    guest = await f.guest(),
    songId = f.store.all("songs")[0].id;
  for (let i = 0; i < 5; i++)
    await f.request(`/api/rooms/${f.room.id}/commands`, {
      session: guest,
      method: "POST",
      body: { commandId: `q-${i}`, type: "enqueue", payload: { songId } },
    });
  const revision = f.store.get("rooms", f.room.id).revision;
  const limited = await f.request(`/api/rooms/${f.room.id}/commands`, {
    session: guest,
    method: "POST",
    body: { commandId: "limited", type: "enqueue", payload: { songId } },
  });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.data.error, "rate_limited");
  assert.ok(limited.response.headers.get("retry-after"));
  assert.equal(f.store.get("rooms", f.room.id).revision, revision);
});

test("logout removes membership and publishes the updated participants", async t => {
  const f = await fixture(t), guest = await f.guest();
  const socket = await f.connect(f.admin);
  await socket.emitWithAck("room:subscribe", { roomId: f.room.id });
  const update = once(socket, "room:state");
  const { response } = await f.request("/api/logout", { session: guest, method: "POST", body: {} });
  assert.equal(response.status, 200);
  const [snapshot] = await update;
  assert.equal(snapshot.participants.some(p => p.id === guest.id), false);
  assert.equal(f.store.get("rooms", f.room.id).members[guest.id], undefined);
});

test("configuration requires trusted HTTPS on non-loopback origins", () => {
  const base = {};
  assert.throws(
    () => configuration({ ...base, PUBLIC_BASE_URL: "http://192.168.1.2" }),
    /https_required/,
  );
  assert.equal(configuration(base).secure, false);
  assert.equal(
    configuration({ ...base, PUBLIC_BASE_URL: "https://karaoke.home.arpa" })
      .secure,
    true,
  );
  assert.equal("adminKey" in configuration({}), false);
  assert.equal("hostKey" in configuration({}), false);
});

test("key login is removed and public launch keeps room owners isolated", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/login", { method: "POST", body: { key: "obsolete" } })).response.status, 410);
  const launch = () => f.request("/api/launch", { method: "POST", body: {} });
  const first = await launch(), second = await launch();
  assert.equal(first.response.status, 201);
  assert.notEqual(first.data.roomId, second.data.roomId);
  const session = { ...first.data, cookie: first.response.headers.get("set-cookie").split(";")[0] };
  assert.equal((await f.request(`/api/rooms/${second.data.roomId}`, { session })).response.status, 403);
});

test("trusted proxies preserve separate launch and join budgets", async t => {
  const f = await fixture(t, { trustedProxies: ["127.0.0.1"] });
  const attempt = (route, forwarded) => f.request(route, {
    method: "POST", body: route === "/api/launch" ? {} : { nickname: "Guest", invitation: "wrong" },
    headers: { "X-Forwarded-For": forwarded },
  });
  for (let i = 0; i < 10; i++) assert.equal((await attempt("/api/launch", "192.0.2.1")).response.status, 201);
  assert.equal((await attempt("/api/launch", "192.0.2.1")).response.status, 429);
  assert.equal((await attempt("/api/launch", "192.0.2.2")).response.status, 201);
  assert.equal((await attempt("/api/launch", "198.51.100.1, 192.0.2.1")).response.status, 429);
  for (let i = 0; i < 30; i++) assert.equal((await attempt("/api/join", "192.0.2.1")).response.status, 403);
  assert.equal((await attempt("/api/join", "192.0.2.1")).response.status, 429);
});

test("HTTP and Socket.IO share the fresh-command budget and return overload without caching it", async t => {
  const f = await fixture(t), guest = await f.guest();
  const socket = await f.connect(guest);
  await socket.emitWithAck("room:subscribe", { roomId: f.room.id });
  for (let i = 0; i < 20; i++) assert.equal((await socket.emitWithAck("room:command", {
    commandId: `denied-${i}`, type: "pause",
  })).error, "forbidden");
  const limited = await f.request(`/api/rooms/${f.room.id}/commands`, {
    session: guest, method: "POST", body: { commandId: "over-budget", type: "pause" },
  });
  assert.equal(limited.response.status, 429);
  assert.ok(limited.response.headers.get("retry-after"));
  assert.equal(f.store.all("commands").length, 20);
});

test("hosted library indexes audio, video, MIDI and case-insensitive companions, and preserves queued YouTube on rescan", async t => {
  const f = await fixture(t);
  for (const filename of ["Song.WAV", "Song.LRC", "Song.CDG", "Song.MID", "Movie.mp4", "Karaoke.kar", "Audio.flac"])
    await fs.writeFile(path.join(f.config.library, filename), "fixture");
  f.store.put("songs", "yt:M7lc1UVf-VE", { id: "yt:M7lc1UVf-VE", title: "Video", artist: "YouTube", format: "youtube", videoId: "M7lc1UVf-VE" });
  await f.server.library.scan();
  const songs = f.store.all("songs"), song = songs.find(s => s.title === "Song" && s.format === "audio");
  assert.ok(song.lyricsId); assert.ok(song.cdgId); assert.ok(song.guideId);
  assert.ok(songs.find(s => s.format === "video"));
  assert.ok(songs.find(s => s.format === "midi"));
  assert.ok(f.store.get("songs", "yt:M7lc1UVf-VE"));
  assert.equal(f.server.library.search("").items.some(s => s.format === "youtube"), false);
});

test("dashboard has two launch choices and QR invitations target the paired control route", async (t) => {
  const f = await fixture(t);
  const home = await f.request("/");
  assert.equal(home.response.status, 200);
  assert.equal((home.data.match(/class="card dashboard-option"/g) || []).length, 2);
  assert.match(home.data, /href="\/tv"/);
  assert.match(home.data, /href="\/control"/);
  for (const route of ["/tv", "/control"]) {
    const page = await f.request(route);
    assert.equal(page.response.status, 200);
    assert.match(page.data, /id="remote-microphone"/);
  }
  const grant = await f.invitation("guest");
  const url = new URL(grant.url);
  assert.equal(url.pathname, "/control");
  assert.equal(url.search, "");
  assert.equal(new URLSearchParams(url.hash.slice(1)).get("invite"), grant.invitation);
  const remote = await f.guest(grant);
  const state = await f.request(`/api/rooms/${f.room.id}`, { session: remote });
  assert.equal(state.response.status, 200);
  assert.equal(state.data.id, f.room.id);
});

test("microphone signaling only connects room guests to the active display and stops on disconnect", async (t) => {
  const f = await fixture(t), remote = await f.guest(), other = await f.guest();
  await f.request(`/api/rooms/${f.room.id}/display/claim`, { session: f.admin, method: "POST", body: {} });
  const tv = await f.connect(f.admin), phone = await f.connect(remote), another = await f.connect(other);
  for (const socket of [tv, phone, another]) await socket.emitWithAck("room:subscribe", { roomId: f.room.id });
  const offer = { type: "offer", sdp: "v=0\r\n" };
  const received = once(tv, "mic:signal");
  assert.equal((await phone.emitWithAck("mic:signal", { target: f.admin.id, description: offer })).accepted, true);
  assert.deepEqual((await received)[0], { from: remote.id, description: offer });
  const answer = { type: "answer", sdp: "v=0\r\n" };
  const answered = once(phone, "mic:signal");
  assert.equal((await tv.emitWithAck("mic:signal", { target: remote.id, description: answer })).accepted, true);
  assert.deepEqual((await answered)[0], { from: f.admin.id, description: answer });
  assert.equal((await phone.emitWithAck("mic:signal", { target: other.id, description: offer })).error, "forbidden");
  assert.equal((await phone.emitWithAck("mic:signal", { target: f.admin.id, description: answer })).accepted, false);
  const closed = once(tv, "mic:closed");
  phone.disconnect();
  assert.equal((await closed)[0].from, remote.id);
  await f.request(`/api/rooms/${f.room.id}/commands`, { session: f.admin, method: "POST", body: { commandId: "remove-mic", type: "revoke", payload: { deviceId: other.id } } });
  assert.equal(f.server.auth.session(other.cookie), null);
});

test("public TVs launch without credentials, own isolated rooms, and keep stable codes until ending", async (t) => {
  const f = await fixture(t);
  const launch = () => f.request("/api/launch", { method: "POST", body: {} });
  const first = await launch(), second = await launch();
  assert.equal(first.response.status, 201);
  assert.equal(second.response.status, 201);
  assert.notEqual(first.data.roomId, second.data.roomId);
  const session = (result) => ({ ...result.data, cookie: result.response.headers.get("set-cookie").split(";")[0] });
  const tv = session(first), otherTV = session(second);
  assert.equal((await f.request(`/api/rooms/${otherTV.roomId}`, { session: tv })).response.status, 403);
  assert.equal((await f.request("/api/admin/library", { session: tv })).response.status, 403);
  const rooms = await f.request("/api/session", { session: tv });
  assert.deepEqual(rooms.data.rooms.map((room) => room.id), [tv.roomId]);
  const resumed = await f.request("/api/launch", { session: tv, method: "POST", body: {} });
  assert.equal(resumed.data.roomId, tv.roomId);
  const pairing = async () => (await f.request(`/api/rooms/${tv.roomId}/pairing`, { session: tv, method: "POST", body: {} })).data;
  const code = await pairing(), again = await pairing();
  assert.equal(code.code, again.code);
  assert.equal(code.url, again.url);
  const joined = await f.request("/api/join", { method: "POST", body: { invitation: code.code, nickname: "Singer" } });
  assert.equal(joined.data.roomId, tv.roomId);
  const phone = session(joined);
  assert.equal((await f.request(`/api/rooms/${tv.roomId}`, { session: phone })).data.canControl, true);
  await f.request(`/api/rooms/${tv.roomId}/commands`, { session: tv, method: "POST", body: { commandId: "end-public-room", type: "end" } });
  assert.equal((await f.request("/api/join", { method: "POST", body: { invitation: code.code, nickname: "Late singer" } })).response.status, 403);
  const fresh = await f.request("/api/launch", { session: tv, method: "POST", body: {} });
  assert.equal(fresh.response.status, 201);
  assert.notEqual(fresh.data.roomId, tv.roomId);

});

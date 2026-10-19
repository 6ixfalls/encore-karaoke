import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
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
    adminKey: "a".repeat(32),
    hostKey: "h".repeat(32),
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
    const { response, data } = await request("/api/login", {
      method: "POST",
      body: { key: (role === "admin" ? "a" : "h").repeat(32) },
    });
    assert.equal(response.status, 200);
    return {
      ...data,
      cookie: response.headers.get("set-cookie").split(";")[0],
    };
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
    "microphone_beta_unavailable",
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
  const base = { ADMIN_KEY: "x".repeat(32) };
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
  assert.throws(() => configuration({ ADMIN_KEY: "weak" }), /admin_key/);
});

test("trusted proxies preserve separate login and join budgets without trusting a forged leftmost IP", async t => {
  const f = await fixture(t, { trustedProxies: ["127.0.0.1"] });
  const attempt = (route, forwarded) => f.request(route, {
    method: "POST", body: route === "/api/login" ? { key: "wrong" } : { nickname: "Guest", invitation: "wrong" },
    headers: { "X-Forwarded-For": forwarded },
  });
  for (let i = 0; i < 10; i++) assert.equal((await attempt("/api/login", "192.0.2.1")).response.status, 401);
  assert.equal((await attempt("/api/login", "192.0.2.1")).response.status, 429);
  assert.equal((await attempt("/api/login", "192.0.2.2")).response.status, 401);
  assert.equal((await attempt("/api/login", "198.51.100.1, 192.0.2.1")).response.status, 429);
  for (let i = 0; i < 30; i++) assert.equal((await attempt("/api/join", "192.0.2.1")).response.status, 403);
  assert.equal((await attempt("/api/join", "192.0.2.1")).response.status, 429);
  assert.equal((await attempt("/api/join", "192.0.2.2")).response.status, 403);
});

test("direct clients cannot reset login throttling with forwarded headers", async t => {
  const f = await fixture(t);
  // The fixture already used one login attempt from the same socket address.
  for (let i = 0; i < 9; i++) assert.equal((await f.request("/api/login", {
    method: "POST", body: { key: "wrong" }, headers: { "X-Forwarded-For": `192.0.2.${i + 1}` },
  })).response.status, 401);
  assert.equal((await f.request("/api/login", {
    method: "POST", body: { key: "wrong" }, headers: { "X-Forwarded-For": "198.51.100.1" },
  })).response.status, 429);
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

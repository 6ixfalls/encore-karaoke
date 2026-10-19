import express from "express";
import { createServer } from "node:http";
import QRCode from "qrcode";
import { Server } from "socket.io";
import { Auth } from "./auth.mjs";
import { Rooms } from "./rooms.mjs";
import { Library } from "./library.mjs";
import { Fault, requireValue, text, number } from "../shared/contracts.js";

export function createApplication(store, config) {
  const app = express(),
    http = createServer(app);
  const auth = new Auth(store, config),
    rooms = new Rooms(store),
    library = new Library(store, config.library);
  let transfers = 0;
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustedProxies?.length ? config.trustedProxies : false);
  app.use((_req, res, next) => {
    res.set({
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    });
    if (config.secure) res.set("Strict-Transport-Security", "max-age=31536000");
    next();
  });
  app.use(express.json({ limit: "16kb", strict: true }));
  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  app.get("/readyz", (_req, res) => {
    store.db.prepare("SELECT 1").get();
    res.json({ status: "ready", library: library.status });
  });
  app.use((req, res, next) => {
    req.session = auth.session(req.headers.cookie);
    if (req.path.startsWith("/api/") || req.path.startsWith("/media/"))
      res.set("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      auth.mutation(req);
      requireValue(req.body && typeof req.body === "object" && !Array.isArray(req.body));
    }
    next();
  });
  app.post("/api/login", (req, res) => {
    auth.throttle(`login:${req.ip}`);
    const role = auth.login(req.body.key);
    const result = auth.create(
      role,
      req.body.nickname || (role === "admin" ? "Administrator" : "Host"),
    );
    res
      .set("Set-Cookie", result.cookie)
      .json({ id: result.session.id, role, csrf: result.session.csrf });
  });
  app.post("/api/join", (req, res) => {
    auth.throttle(`join:${req.ip}`, 30);
    auth.throttle("join:global", 300);
    // Create the cookie only after checking the grant; failed joins leave no session records.
    const created = auth.create("guest", text(req.body.nickname, 40));
    let room;
    try {
      room = rooms.join(req.body.invitation, created.session);
    } catch (error) {
      store.delete("sessions", created.session.tokenHash);
      throw error;
    }
    res
      .set("Set-Cookie", created.cookie)
      .json({
        id: created.session.id,
        role: created.session.role,
        csrf: created.session.csrf,
        roomId: room.id,
      });
    publish(room.id);
  });
  app.use("/api", (req, _res, next) => {
    requireValue(req.session, "unauthorized", 401);
    next();
  });
  app.get("/api/session", (req, res) => {
    const s = req.session;
    res.json({
      id: s.id,
      role: s.role,
      csrf: s.csrf,
      roomId: s.roomId,
      rooms: store
        .all("rooms")
        .filter(
          (r) =>
            r.status !== "ended" &&
            (s.role === "admin" ||
              r.members[s.id] ||
              (rooms.host(s) &&
                s.principal &&
                r.ownerPrincipal === s.principal)),
        )
        .map((r) => ({ id: r.id, name: r.name })),
    });
  });
  app.post("/api/logout", (req, res) => {
    req.session.revoked = true;
    store.put("sessions", req.session.tokenHash, req.session);
    res
      .set(
        "Set-Cookie",
        `encore_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${config.secure ? "; Secure" : ""}`,
      )
      .json({ ok: true });
    for (const r of store.all("rooms").filter((r) => r.members[req.session.id])) {
      delete r.members[req.session.id];
      r.revision++;
      store.put("rooms", r.id, r);
      publish(r.id);
    }
  });
  app.post("/api/rooms", (req, res) =>
    res
      .status(201)
      .json(
        rooms.snapshot(rooms.create(req.session, req.body.name), req.session),
      ),
  );
  app.get("/api/rooms/:roomId", (req, res) =>
    res.json(
      rooms.snapshot(rooms.room(req.params.roomId, req.session), req.session),
    ),
  );
  app.post("/api/rooms/:roomId/invitations", async (req, res) => {
    const grant = rooms.invite(req.params.roomId, req.session, req.body.kind);
    // Fragment secrets never enter the access log or the Referer header.
    const url = `${config.origin}/#invite=${grant.invitation}`;
    res.json({
      ...grant,
      url,
      qr: await QRCode.toDataURL(url, { margin: 2, width: 256 }),
    });
  });
  app.post("/api/rooms/:roomId/commands", (req, res) => {
    const ack = rooms.command(req.params.roomId, req.session, req.body);
    if (ack.retryAfterMs)
      res.set("Retry-After", String(Math.ceil(ack.retryAfterMs / 1000)));
    res.status(ack.accepted ? 200 : ack.status).json(ack);
    publish(req.params.roomId);
  });
  app.post("/api/rooms/:roomId/display/claim", (req, res) => {
    const grant = rooms.claim(req.params.roomId, req.session);
    res.status(grant.pending ? 409 : 200).json(grant);
    publish(req.params.roomId);
  });
  app.post("/api/rooms/:roomId/display/renew", (req, res) =>
    res.json(rooms.renew(req.params.roomId, req.session, req.body.generation)),
  );
  app.post("/api/admin/rooms/:roomId/retire", (req, res) => {
    const room = rooms.retire(req.params.roomId, req.session, req.body);
    res.json({ ok: true });
    publish(room.id);
  });
  app.post("/api/admin/library/rescan", (req, res) => {
    requireValue(req.session.role === "admin", "forbidden", 403);
    requireValue(!library.scanning, "scan_in_progress", 409);
    library.scan().catch(() => {});
    res.status(202).json({ state: "scanning" });
  });
  app.get("/api/admin/library", (req, res) => {
    requireValue(req.session.role === "admin", "forbidden", 403);
    res.json(library.status);
  });
  app.get("/api/library/search", (req, res) => {
    rooms.room(String(req.query.roomId || ""), req.session);
    const q = req.query.q || "";
    requireValue(typeof q === "string" && q.length <= 200);
    const offset = number(Number(req.query.offset || 0), 0, 100_000);
    res.json(library.search(q, Math.floor(offset)));
  });
  app.get("/api/library/songs/:id", (req, res) => {
    rooms.room(String(req.query.roomId || ""), req.session);
    const song = store.get("songs", req.params.id);
    requireValue(song, "song_not_found", 404);
    res.json(song);
  });
  // A narrowly scoped bearer token can retire an old generation after authentication-epoch rotation.
  // It can never acquire a session, renew a lease, or control the room.
  app.post("/display-release/:roomId", (req, res) => {
    const room = rooms.release(
      req.params.roomId,
      req.body.generation,
      req.body.releaseToken,
    );
    res.json({ ok: true });
    publish(room.id);
  });
  app.get("/media/:id", async (req, res) => {
    requireValue(req.session, "unauthorized", 401);
    rooms.room(String(req.query.roomId || ""), req.session);
    requireValue(transfers < config.maxTransfers, "transfer_limit", 503);
    transfers++;
    let handle;
    let stream;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      transfers--;
      if (stream) stream.destroy();
      else if (handle) handle.close().catch(() => {});
    };
    res.once("close", finish);
    try {
      const opened = await library.open(req.params.id);
      handle = opened.handle;
      if (finished) {
        await handle.close();
        return;
      }
      const { stat, asset } = opened;
      const etag = `"${stat.size}-${stat.mtimeMs}"`;
      res.set({
        "Content-Type": asset.type,
        "Accept-Ranges": "bytes",
        ETag: etag,
        "Last-Modified": stat.mtime.toUTCString(),
        "Cache-Control": "private, no-cache",
      });
      if (req.headers["if-none-match"] === etag) {
        res.status(304).end();
        finish();
        return;
      }
      let start = 0,
        end = stat.size - 1;
      const range = req.headers.range;
      if (
        range &&
        (!req.headers["if-range"] ||
          req.headers["if-range"] === etag ||
          req.headers["if-range"] === stat.mtime.toUTCString())
      ) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) {
          res.set("Content-Range", `bytes */${stat.size}`).status(416).end();
          finish();
          return;
        }
        if (!match[1]) start = Math.max(0, stat.size - Number(match[2]));
        else {
          start = Number(match[1]);
          if (match[2]) end = Math.min(end, Number(match[2]));
        }
        if (
          start > end ||
          start >= stat.size ||
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end)
        ) {
          res.set("Content-Range", `bytes */${stat.size}`).status(416).end();
          finish();
          return;
        }
        res
          .status(206)
          .set("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      }
      res.set("Content-Length", String(Math.max(0, end - start + 1)));
      if (req.method === "HEAD" || stat.size === 0) {
        res.end();
        finish();
        return;
      }
      stream = handle.createReadStream({ start, end, autoClose: true });
      stream.on("error", () => res.destroy());
      stream.pipe(res);
    } catch (error) {
      finish();
      throw error;
    }
  });
  app.use(
    express.static(config.web, {
      index: "index.html",
      dotfiles: "deny",
      redirect: false,
    }),
  );
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.destroy();
    const status =
      error instanceof Fault
        ? error.status
        : error.type === "entity.too.large"
          ? 413
          : error instanceof SyntaxError
            ? 400
            : error.code === "ENOENT"
              ? 404
              : 500;
    if (error.retryAfterMs)
      res.set("Retry-After", String(Math.ceil(error.retryAfterMs / 1000)));
    res
      .status(status)
      .json({
        error:
          error instanceof Fault
            ? error.code
            : status === 500
              ? "internal_error"
              : "invalid_request",
        retryAfterMs: error.retryAfterMs,
      });
  });
  const io = new Server(http, {
    serveClient: true,
    maxHttpBufferSize: 16 * 1024,
    allowRequest: (req, callback) =>
      callback(
        null,
        req.headers.origin === config.origin &&
          !!auth.session(req.headers.cookie),
      ),
  });
  io.use((socket, next) => {
    const session = auth.session(socket.request.headers.cookie);
    if (
      !session ||
      socket.handshake.auth?.csrf !== session.csrf ||
      socket.handshake.headers.origin !== config.origin
    )
      return next(new Error("unauthorized"));
    socket.data.sessionId = session.id;
    next();
  });
  const socketSession = (socket) => {
    const s = auth.session(socket.request.headers.cookie);
    requireValue(s?.id === socket.data.sessionId, "unauthorized", 401);
    auth.throttle(`socket:${s.id}`, 600);
    return s;
  };
  function publish(roomId) {
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.roomId !== roomId) continue;
      try {
        const s = auth.session(socket.request.headers.cookie);
        socket.emit(
          "room:state",
          rooms.snapshot(rooms.room(roomId, s, { ended: true }), s),
        );
        if (store.get("rooms", roomId).status === "ended")
          socket.disconnect(true);
      } catch {
        socket.emit("session:revoked");
        socket.disconnect(true);
      }
    }
  }
  io.on("connection", (socket) => {
    const handle = (event, fn) =>
      socket.on(event, (message, callback) => {
        const reply = typeof callback === "function" ? callback : () => {};
        try {
          reply(fn(message, socketSession(socket)));
        } catch (error) {
          reply({
            accepted: false,
            error: error instanceof Fault ? error.code : "invalid_request",
            retryAfterMs: error.retryAfterMs,
          });
        }
      });
    handle("room:subscribe", (message, session) => {
      const room = rooms.room(text(message?.roomId, 100), session);
      socket.data.roomId = room.id;
      const snapshot = rooms.snapshot(room, session);
      socket.emit("room:state", snapshot);
      return snapshot;
    });
    handle("room:command", (message, session) => {
      requireValue(socket.data.roomId, "room_required");
      const ack = rooms.command(socket.data.roomId, session, message);
      publish(socket.data.roomId);
      return ack;
    });
    handle("display:telemetry", (message, session) => {
      requireValue(message && socket.data.roomId, "room_required");
      rooms.telemetry(socket.data.roomId, session, message);
      publish(socket.data.roomId);
      return { accepted: true };
    });
    // Remote microphones are intentionally disabled until the hardware feasibility gate passes.
    handle("mic:signal", () => {
      throw new Fault("microphone_beta_unavailable", 403);
    });
  });
  let sweepCount = 0;
  const sweep = setInterval(() => {
    for (const room of store.all("rooms")) {
      if (
        room.lease &&
        !room.lease.retired &&
        !room.lease.releaseRequested &&
        !rooms.available(room)
      ) {
        room.lease.releaseRequested = true;
        room.desired = "paused";
        room.observed = "unavailable";
        room.revision++;
        store.put("rooms", room.id, room);
        publish(room.id);
      }
    }
    if (++sweepCount % 60 !== 0) return;
    for (const table of ["sessions", "commands", "invites"])
      store.db
        .prepare(
          `DELETE FROM ${table} WHERE json_extract(value,'$.expires') < ?`,
        )
        .run(Date.now());
  }, 1000);
  sweep.unref();
  return {
    app,
    http,
    io,
    auth,
    rooms,
    library,
    publish,
    async close() {
      clearInterval(sweep);
      await new Promise((resolve) => io.close(resolve));
      store.close();
    },
  };
}

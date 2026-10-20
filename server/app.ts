import type { Store } from "./store.js";
import type { Configuration } from "./config.js";
import type { Session, Command, Telemetry } from "./types.js";
import { serviceError } from "./types.js";
import type { Request, Response, NextFunction } from "express";
import type { Socket } from "socket.io";

declare module "express-serve-static-core" {
  interface Request {
    session: Session | null;
  }
}

import express from "express";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { YouTube } from "./youtube.js";
import { Separations } from "./separation.js";
import { Lyrics } from "./lyrics.js";
import { createServer } from "node:http";
import QRCode from "qrcode";
import { Server } from "socket.io";
import { Participants } from "./participants.js";
import { Rooms } from "./rooms.js";
import { Fault, requireValue, text } from "../shared/contracts.js";

export function createApplication(store: Store, config: Configuration) {
  const app = express(),
    http = createServer(app);
  const participants = new Participants(store, config), rooms = new Rooms(store);
  const participant = (req: Request): Session => {
    requireValue(req.session, "unauthorized", 401);
    return req.session;
  };
  const youtube = new YouTube(config.ytDlp);
  const separations = new Separations(config, youtube, undefined, new Lyrics());
  let transfers = 0;
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustedProxies?.length ? config.trustedProxies : false);
  app.use((_req, res, next) => {
    res.set({
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; frame-src 'none'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "Permissions-Policy": "camera=(), microphone=(self), geolocation=()",
    });
    if (config.secure) res.set("Strict-Transport-Security", "max-age=31536000");
    next();
  });
  app.use(express.json({ limit: "16kb", strict: true }));
  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  app.get("/readyz", (_req, res) => {
    res.json({ status: "ready" });
  });
  app.use((req, res, next) => {
    req.session = participants.session(req.headers["x-participant-token"] || (req.path.startsWith("/media/") ? req.query.participant : undefined));
    if (req.path.startsWith("/api/") || req.path.startsWith("/media/"))
      res.set("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      participants.mutation(req);
      requireValue(req.body && typeof req.body === "object" && !Array.isArray(req.body));
    }
    next();
  });
  // Every public TV receives an independent owner; no shared host credential.
  app.post("/api/launch", (req, res) => {
    participants.throttle(`launch:${req.ip}`, 10);
    participants.throttle("launch:global", 100);
    const previous = req.session;
    if (previous && rooms.host(previous)) {
      const existing = store.all("rooms").find((room) => room.status !== "ended" && room.screenId === previous.id);
      if (existing) {
        res.json({ id: previous.id, role: previous.role, roomId: existing.id });
        return;
      }
    }
    const created = participants.create("host", "Karaoke TV");
    try {
      const room = rooms.create(created.session, "Encore Karaoke");
      room.policy.guestControl = true;
      room.expires = Date.now() + 24 * 60 * 60_000;
      store.put("rooms", room.id, room);
      created.session.roomId = room.id;
      store.put("sessions", created.session.tokenHash, created.session);
      res.status(201).json({ id: created.session.id, role: "host", token: created.token, roomId: room.id });
    } catch (error) {
      store.delete("sessions", created.session.tokenHash);
      throw error;
    }
  });
  app.post("/api/join", (req, res) => {
    participants.throttle(`join:${req.ip}`, 30);
    participants.throttle("join:global", 300);
    // Failed joins leave no participant records.
    const created = participants.create("guest", text(req.body.nickname, 40));
    let room;
    try {
      room = rooms.join(req.body.invitation, created.session);
    } catch (error) {
      store.delete("sessions", created.session.tokenHash);
      throw error;
    }
    res.json({
      id: created.session.id,
      role: created.session.role,
      token: created.token,
      roomId: room.id,
    });
    publish(room.id);
  });
  app.use("/api", (req, _res, next) => {
    participant(req);
    next();
  });
  app.get("/api/session", (req, res) => {
    const s = participant(req);
    res.json({
      id: s.id,
      role: s.role,
      roomId: s.roomId,
      rooms: store
        .all("rooms")
        .filter(
          (r) =>
            r.status !== "ended" &&
            r.members[s.id],
        )
        .map((r) => ({ id: r.id, name: r.name })),
    });
  });
  app.post("/api/logout", (req, res) => {
    participant(req).revoked = true;
    store.put("sessions", participant(req).tokenHash, participant(req));
    res.json({ ok: true });
    for (const r of store.all("rooms").filter((r) => r.members[participant(req).id])) {
      delete r.members[participant(req).id];
      r.revision++;
      store.put("rooms", r.id, r);
      publish(r.id);
    }
  });
  app.get("/api/rooms/:roomId", (req, res) =>
    res.json(
      rooms.snapshot(rooms.room(req.params.roomId, participant(req)), participant(req)),
    ),
  );
  app.post("/api/rooms/:roomId/pairing", async (req, res) => {
    const grant = rooms.pairing(req.params.roomId, participant(req));
    const url = `${config.origin}/control#invite=${grant.invitation}`;
    res.json({ ...grant, url, qr: await QRCode.toDataURL(url, { margin: 2, width: 256 }) });
  });
  app.post("/api/rooms/:roomId/commands", (req, res) => {
    const ack = rooms.command(req.params.roomId, participant(req), req.body);
    if (ack.retryAfterMs)
      res.set("Retry-After", String(Math.ceil(ack.retryAfterMs / 1000)));
    res.status(ack.accepted ? 200 : ack.status ?? 400).json(ack);
    publish(req.params.roomId);
  });
  app.post("/api/rooms/:roomId/display/claim", (req, res) => {
    const grant = rooms.claim(req.params.roomId, participant(req));
    res.json(grant);
    publish(req.params.roomId);
  });
  app.post("/api/rooms/:roomId/display/renew", (req, res) =>
    res.json(rooms.renew(req.params.roomId, participant(req), req.body.generation)),
  );
  app.get("/api/youtube/search", async (req, res) => {
    rooms.room(String(req.query.roomId || ""), participant(req));
    participants.throttle(`youtube:${participant(req).id}`, 10);
    participants.throttle("youtube:global", 100);
    const items = await youtube.search(text(req.query.q, 200));
    for (const item of items) store.put("songs", `yt:${item.videoId}`, {
      id: `yt:${item.videoId}`, format: "youtube", ...item, metadataExpires: Date.now() + 10 * 60_000,
    });
    res.json({ items });
  });
  app.get("/api/youtube/:id/metadata", async (req, res) => {
    rooms.room(String(req.query.roomId || ""), participant(req));
    participants.throttle(`youtube:${participant(req).id}`, 10);
    participants.throttle("youtube:global", 100);
    const item = await youtube.metadata(req.params.id);
    store.put("songs", `yt:${item.videoId}`, {
      id: `yt:${item.videoId}`, format: "youtube", ...item, metadataExpires: Date.now() + 10 * 60_000,
    });
    res.json(item);
  });
  app.post("/api/rooms/:roomId/separation", async (req, res) => {
    const session = participant(req), room = rooms.room(req.params.roomId, session);
    requireValue(room.lease?.deviceId === session.id && rooms.available(room) && !room.lease.releaseRequested, "display_required", 403);
    requireValue(room.current && room.current.playbackId === req.body.playbackId, "stale_playback", 409);
    const song = store.get("songs", room.current.songId);
    requireValue(song?.format === "youtube" && song.videoId, "youtube_song_required");
    const playbackId = room.current.playbackId, generation = room.lease.generation;
    const current = () => {
      const active = store.get("rooms", room.id);
      return !!participants.session(req.headers["x-participant-token"]) && !!active && active.status !== "ended" &&
        active.current?.playbackId === playbackId && active.lease?.generation === generation &&
        active.lease?.deviceId === session.id && !active.lease?.releaseRequested && rooms.available(active);
    };
    const job = await separations.create(room.id, playbackId, session.id, song.videoId, current);
    res.status(201).json({ id: job.id, ready: separations.playable(job), media: `/media/separation/${job.id}?roomId=${room.id}&participant=${encodeURIComponent(String(req.headers["x-participant-token"]))}` });
  });
  app.get("/api/rooms/:roomId/separation/:id", (req, res) => {
    const session = participant(req);
    rooms.room(req.params.roomId, session);
    const job = separations.get(req.params.id, req.params.roomId, session.id);
    res.json({ ...job.frames.snapshot(), state: job.state, complete: job.referenceComplete,
      mediaComplete: job.writer.writableFinished, ready: separations.playable(job),
      lyrics: job.lyrics, lyricsPending: job.lyrics === undefined });
  });
  app.post("/api/rooms/:roomId/separation/:id/stop", (req, res) => {
    separations.stopOwned(req.params.id, req.params.roomId, participant(req).id);
    res.json({ ok: true });
  });
  app.head("/media/separation/:id", (req, res) => {
    const session = participant(req), roomId = String(req.query.roomId || "");
    rooms.room(roomId, session);
    const job = separations.get(req.params.id, roomId, session.id);
    requireValue(separations.playable(job), "media_preparing", 409);
    res.set({ "Cache-Control": "no-store", "Content-Type": "video/mp4" });
    if (job.writer.writableFinished) res.sendFile(job.file);
    else res.set("Accept-Ranges", "none").end();
  });
  app.get("/media/separation/:id", (req, res) => {
    const session = participant(req), roomId = String(req.query.roomId || "");
    rooms.room(roomId, session);
    const job = separations.get(req.params.id, roomId, session.id);
    requireValue(separations.playable(job), "media_preparing", 409);
    requireValue(transfers < config.maxTransfers, "transfer_limit", 503);
    job.claimed = true; transfers++;
    res.once("close", () => { transfers--; });
    res.set({ "Cache-Control": "no-store", "Content-Type": "video/mp4" });
    if (job.writer.writableFinished) { res.sendFile(job.file); return; }
    res.set({ "Accept-Ranges": "none", "X-Accel-Buffering": "no" });
    const controller = new AbortController();
    const stream = separations.media(job, controller.signal);
    res.once("close", () => { controller.abort(); stream.destroy(); });
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  });
  app.get("/media/youtube/:id", async (req, res) => {
    const session = participant(req);
    rooms.room(String(req.query.roomId || ""), session);
    requireValue(/^[\w-]{11}$/.test(req.params.id), "invalid_youtube_id");
    requireValue(transfers < config.maxTransfers, "transfer_limit", 503);
    transfers++;
    const controller = new AbortController();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      transfers--;
      controller.abort();
    };
    res.once("close", finish);
    try {
      const upstream = await youtube.stream(req.params.id, req.headers.range, controller.signal, req.method === "HEAD");
      if (finished) { await upstream.body?.cancel(); return; }
      res.status(upstream.status);
      for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
        const value = upstream.headers.get(name);
        if (value) res.set(name, value);
      }
      if (!upstream.body || req.method === "HEAD") { await upstream.body?.cancel(); res.end(); return; }
      const stream = Readable.fromWeb(upstream.body as unknown as ReadableStream);
      res.once("close", () => stream.destroy());
      stream.on("error", () => res.destroy());
      stream.pipe(res);
    } catch (error) {
      finish();
      throw error;
    }
  });

  app.post("/api/rooms/:roomId/display/stop", (req, res) => {
    const room = rooms.release(req.params.roomId, participant(req), req.body.generation);
    res.json({ ok: true });
    publish(room.id);
  });
  app.get(["/tv", "/control"], (_req, res) => res.sendFile("app.html", { root: config.web }));
  app.use(
    express.static(config.web, {
      index: "index.html",
      dotfiles: "deny",
      redirect: false,
    }),
  );
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use((caught: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const error = serviceError(caught);
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
    // Network heartbeats also wake background TVs whose JS timers are throttled.
    pingInterval: 2000,
    maxHttpBufferSize: 16 * 1024,
    allowRequest: (req, callback) =>
      callback(
        null,
        req.headers.origin === config.origin,
      ),
  });
  io.use((socket, next) => {
    const session = participants.session(socket.handshake.auth?.token);
    if (
      !session ||
      socket.handshake.headers.origin !== config.origin
    )
      return next(new Error("unauthorized"));
    socket.data.sessionId = session.id;
    next();
  });
  const socketSession = (socket: Socket) => {
    const s = participants.session(socket.handshake.auth?.token);
    requireValue(s && s.id === socket.data.sessionId, "unauthorized", 401);
    participants.throttle(`socket:${s.id}`, 600);
    return s;
  };
  function publish(roomId: string) {
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.roomId !== roomId) continue;
      try {
        const s = participants.session(socket.handshake.auth?.token);
        socket.emit(
          "room:state",
          rooms.snapshot(rooms.room(roomId, s, { ended: true }), s!),
        );
        if (store.get("rooms", roomId)?.status === "ended")
          socket.disconnect(true);
      } catch {
        socket.emit("session:revoked");
        socket.disconnect(true);
      }
    }
  }
  io.on("connection", (socket) => {
    const handle = <T>(event: string, fn: (message: T, session: Session) => unknown) =>
      socket.on(event, (message, callback) => {
        const reply = typeof callback === "function" ? callback : () => {};
        try {
          reply(fn(message, socketSession(socket)));
        } catch (error) {
          reply({
            accepted: false,
            error: error instanceof Fault ? error.code : "invalid_request",
            retryAfterMs: serviceError(error).retryAfterMs,
          });
        }
      });
    handle<{ roomId?: unknown }>("room:subscribe", (message, session) => {
      const room = rooms.room(text(message?.roomId, 100), session);
      socket.data.roomId = room.id;
      const snapshot = rooms.snapshot(room, session);
      socket.emit("room:state", snapshot);
      return snapshot;
    });
    handle<Command>("room:command", (message, session) => {
      requireValue(socket.data.roomId, "room_required");
      const ack = rooms.command(socket.data.roomId, session, message);
      publish(socket.data.roomId);
      return ack;
    });
    handle<Telemetry>("display:telemetry", (message, session) => {
      requireValue(message && socket.data.roomId, "room_required");
      rooms.telemetry(socket.data.roomId, session, message);
      publish(socket.data.roomId);
      return { accepted: true };
    });
    handle<{ target: string; description?: { type: string; sdp: string }; candidate?: { candidate: string; sdpMid?: string; sdpMLineIndex?: number } }>("mic:signal", (message, session) => {
      requireValue(message && socket.data.roomId, "room_required");
      const room = rooms.room(socket.data.roomId, session);
      requireValue(rooms.available(room) && room.lease && !room.lease.releaseRequested, "display_unavailable", 409);
      const target = text(message.target, 100);
      const display = room.lease.deviceId;
      requireValue(session.id !== target &&
        ((session.id === display && room.members[target]?.role === "guest") ||
         (target === display && session.role === "guest")), "forbidden", 403);
      requireValue(!!message.description !== !!message.candidate);
      let payload;
      if (message.description) {
        const description = message.description;
        requireValue(description.type === (session.id === display ? "answer" : "offer"));
        requireValue(typeof description.sdp === "string" && description.sdp.length > 0 && description.sdp.length <= 12000);
        payload = { description: { type: description.type, sdp: description.sdp } };
      } else {
        const candidate = message.candidate!;
        requireValue(typeof candidate.candidate === "string" && candidate.candidate.length <= 2048);
        requireValue(candidate.sdpMid == null || (typeof candidate.sdpMid === "string" && candidate.sdpMid.length <= 256));
        requireValue(candidate.sdpMLineIndex == null || (Number.isInteger(candidate.sdpMLineIndex) && candidate.sdpMLineIndex >= 0 && candidate.sdpMLineIndex < 100));
        payload = { candidate: { candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex } };
      }
      const recipient = [...io.sockets.sockets.values()].find((peer) => peer.data.sessionId === target && peer.data.roomId === room.id);
      requireValue(recipient, "microphone_peer_unavailable", 409);
      socketSession(recipient);
      recipient.emit("mic:signal", { from: session.id, ...payload });
      return { accepted: true };
    });
    const closeMicrophone = () => {
      for (const peer of io.sockets.sockets.values())
        if (peer.id !== socket.id && peer.data.roomId === socket.data.roomId)
          peer.emit("mic:closed", { from: socket.data.sessionId });
    };
    handle("mic:close", () => { closeMicrophone(); return { accepted: true }; });
    socket.on("disconnect", closeMicrophone);
  });
  const sweep = setInterval(() => {
    separations.sweep();
    for (const room of store.all("rooms")) {
      if (room.expires && room.expires < Date.now() && room.status !== "ended") {
        room.status = "ended";
        room.desired = "paused";
        if (room.lease) room.lease.releaseRequested = true;
        room.revision++;
        store.put("rooms", room.id, room);
        publish(room.id);
      }
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
    const now = Date.now();
    store.sweep(now);
    for (const room of store.all("rooms")) {
      if (room.status !== "ended") continue;
      publish(room.id);
      if (room.lease) rooms.deadlines.delete(room.lease.generation);
      for (const session of store.all("sessions"))
        if (session.roomId === room.id) store.delete("sessions", session.tokenHash);
      for (const invite of store.all("invites"))
        if (invite.roomId === room.id) {
          store.delete("invites", invite.code); store.delete("invites", invite.invitation);
        }
      store.delete("rooms", room.id);
    }
    const referencedSongs = new Set<string>();
    for (const room of store.all("rooms")) {
      if (room.current) referencedSongs.add(room.current.songId);
      for (const item of room.queue) referencedSongs.add(item.songId);
    }
    for (const song of store.all("songs"))
      if (!referencedSongs.has(song.id) && (song.metadataExpires ?? 0) <= now) store.delete("songs", song.id);
  }, 1000);
  sweep.unref();
  return {
    app,
    http,
    io,
    participants,
    rooms,
    youtube,
    separations,
    publish,
    async close() {
      clearInterval(sweep);
      separations.close();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      store.close();
    },
  };
}

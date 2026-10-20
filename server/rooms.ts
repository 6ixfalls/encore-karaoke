import type { Store } from "./store.js";
import type { Room, Session, Invitation, Command, CommandResult, Telemetry } from "./types.js";
import { randomUUID, randomInt } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  COMMANDS,
  LIMITS,
  Fault,
  requireValue,
  text,
  number,
} from "../shared/contracts.js";
import { secret, digest } from "./store.js";

export class Rooms {
  clock: () => number;
  monotonic: () => number;
  deadlines: Map<string, number>;
  constructor(
    private store: Store,
    { clock = Date.now, monotonic = () => performance.now() } = {},
  ) {
    this.clock = clock;
    this.monotonic = monotonic;
    this.deadlines = new Map();
  }
  host(session: Session) {
    return session.role === "host";
  }
  room(id: string, session: Session | null, { ended = false } = {}) {
    const room = this.store.get("rooms", id);
    requireValue(
      room && (ended || room.status !== "ended"),
      "room_not_found",
      404,
    );
    requireValue(
      session && !session.revoked,
      "unauthorized",
      401,
    );
    requireValue(
      room.members[session.id],
      "forbidden",
      403,
    );
    return room;
  }
  create(session: Session, name: unknown) {
    requireValue(this.host(session), "forbidden", 403);
    requireValue(
      this.store.all("rooms").filter((r) => r.status !== "ended").length < 32,
      "room_limit",
      409,
    );
    const room: Room = {
      id: randomUUID(),
      name: text(name),
      screenId: session.id,
      status: "open",
      revision: 0,
      queue: [],
      current: null,
      desired: "paused",
      observed: "idle",
      volume: 0.65,
      tempo: 1,
      position: 0,
      members: {
        [session.id]: { nickname: session.nickname, role: session.role },
      },
      policy: {
        roomCap: LIMITS.room,
        guestCap: LIMITS.guest,
        guestControl: false,
      },
      lease: null,
    };
    this.store.put("rooms", room.id, room);
    return room;
  }
  snapshot(room: Room, session: Session) {
    return {
      protocol: 1,
      id: room.id,
      name: room.name,
      status: room.status,
      revision: room.revision,
      queue: room.queue,
      current: room.current,
      seekable: true,
      duration: room.current ? this.store.get("songs", room.current.songId)?.duration : undefined,
      desired: room.desired,
      observed: room.observed,
      volume: room.volume,
      tempo: room.tempo,
      position: room.position,
      sampleTime: room.sampleTime,
      scores: room.scores || [],
      policy: room.policy,
      participants: Object.entries(room.members).map(([id, m]) => ({
        id,
        ...m,
      })),
      lease: room.lease && {
        deviceId: room.lease.deviceId,
        generation: room.lease.generation,
        deadline: room.lease.deadline,
        releaseRequested: room.lease.releaseRequested,
        retired: room.lease.retired,
      },
      canControl: this.host(session) || room.policy.guestControl,
    };
  }
  pairing(roomId: string, session: Session) {
    const room = this.room(roomId, session);
    requireValue(this.host(session), "forbidden", 403);
    requireValue(room.status !== "ended", "room_not_found", 404);
    if (!room.pairing) {
      let code;
      do { code = String(randomInt(100000, 1000000)); }
      while (this.store.get("invites", digest(code)));
      room.pairing = { code, token: secret() };
      this.store.put("rooms", room.id, room);
    }
    const grant: Invitation = {
      roomId,
      invitation: digest(room.pairing.token), code: digest(room.pairing.code),
      expires: room.expires || this.clock() + 24 * 60 * 60_000,
    };
    this.store.put("invites", grant.invitation, grant);
    this.store.put("invites", grant.code, grant);
    return { invitation: room.pairing.token, code: room.pairing.code, expires: grant.expires };
  }
  join(invitation: unknown, session: Session) {
    return this.store.transaction(() => {
      const grant = this.store.get("invites", digest(text(invitation, 128)));
      requireValue(
        grant &&
          grant.expires > this.clock(),
        "expired_invitation",
        403,
      );
      const room = this.store.get("rooms", grant.roomId);
      requireValue(room && room.status === "open", "room_locked", 403);
      const activeMembers = new Set(
        this.store.all("sessions")
          .filter((s) => !s.revoked && s.expires > this.clock())
          .map((s) => s.id),
      );
      for (const id of Object.keys(room.members))
        if (!activeMembers.has(id)) delete room.members[id];
      requireValue(Object.keys(room.members).length < 200, "room_full", 409);
      session.role = "guest";
      session.roomId = room.id;
      room.members[session.id] = {
        nickname: session.nickname,
        role: session.role,
      };
      room.revision++;
      this.store.put("sessions", session.tokenHash, session);
      this.store.put("rooms", room.id, room);
      return room;
    });
  }
  command(roomId: string, session: Session, command: Command): CommandResult {
    requireValue(command && typeof command === "object");
    text(command.commandId, 100);
    requireValue(COMMANDS.has(command.type), "unknown_command");
    const key = digest(`${roomId}:${session.id}:${command.commandId}`);
    const fingerprint = digest(JSON.stringify(command));
    return this.store.transaction(() => {
      const room = this.room(roomId, session);
      const previous = this.store.get("commands", key);
      if (previous && previous.expires > this.clock()) {
        requireValue(
          previous.fingerprint === fingerprint,
          "command_id_reused",
          409,
        );
        return previous.result;
      }
      const retryAfterMs = this.admitCommand(session);
      if (retryAfterMs)
        return {
          commandId: command.commandId,
          accepted: false,
          revision: room.revision,
          error: "rate_limited",
          status: 429,
          retryAfterMs,
        };
      let result: CommandResult;
      try {
        if (command.type === "enqueue") this.admit(room, session);
        if (command.expectedRevision !== undefined)
          requireValue(
            command.expectedRevision === room.revision,
            "revision_conflict",
            409,
          );
        this.apply(room, session, command.type, command.payload || {});
        room.revision++;
        this.store.put("rooms", room.id, room);
        result = {
          commandId: command.commandId,
          accepted: true,
          revision: room.revision,
        };
      } catch (error) {
        if (!(error instanceof Fault)) throw error;
        result = {
          commandId: command.commandId,
          accepted: false,
          revision: room.revision,
          error: error.code,
          status: error.status,
          retryAfterMs: error.retryAfterMs,
        };
      }
      this.store.put("commands", key, {
        fingerprint,
        result,
        expires: this.clock() + (result.accepted ? 86_400_000 : LIMITS.rejectedCommandMs),
      });
      return result;
    });
  }
  admitCommand(session: Session) {
    const now = this.clock();
    const device = `command:${session.id}`;
    this.store.attempts = this.store.attempts.filter(a => a.time > now - LIMITS.windowMs);
    const attempts = this.store.attempts.filter(a => a.room === "commands");
    const own = attempts.filter((a) => a.device === device);
    if (own.length >= LIMITS.commandDeviceRate)
      return LIMITS.windowMs - (now - Number(own[0].time));
    if (attempts.length >= LIMITS.commandGlobalRate)
      return LIMITS.windowMs - (now - Number(attempts[0].time));
    this.store.attempts.push({ device, room: "commands", time: now });
    return 0;
  }
  admit(room: Room, session: Session) {
    const now = this.clock();
    this.store.attempts = this.store.attempts.filter(a => a.time > now - LIMITS.windowMs);
    const device = this.store.attempts.filter(a => a.device === session.id);
    const total = this.store.attempts.filter(a => a.room === room.id);
    if (device.length >= LIMITS.deviceRate || total.length >= LIMITS.roomRate)
      throw new Fault("rate_limited", 429, LIMITS.windowMs - (now - Math.min(device[0]?.time ?? now, total[0]?.time ?? now)));
    this.store.attempts.push({ device: session.id, room: room.id, time: now });
    requireValue(room.queue.length < room.policy.roomCap, "queue_full", 409);
    if (!this.host(session))
      requireValue(
        room.queue.filter((q) => q.owner === session.id).length <
          room.policy.guestCap,
        "reservation_limit",
        409,
      );
  }
  apply(room: Room, session: Session, type: string, p: Record<string, unknown>) {
    const host = this.host(session);
    if (type === "enqueue") {
      requireValue(room.status === "open" || host, "room_locked", 403);
      const videoId = text(p.youtube, 11);
      requireValue(/^[a-zA-Z0-9_-]{11}$/.test(videoId), "invalid_youtube_id");
      const metadata = this.store.get("songs", `yt:${videoId}`);
      const song = metadata || { id: `yt:${videoId}`, title: text(p.title, 200), artist: typeof p.artist === "string" ? text(p.artist, 200) : "Unknown artist", format: "youtube" as const, videoId };
      delete song.metadataExpires;
      this.store.put("songs", song.id, song);
      room.queue.push({
        id: randomUUID(),
        songId: song.id,
        title: song.title,
        artist: song.artist,
        owner: session.id,
        nickname: session.nickname,
      });
      if (!room.current && this.available(room)) {
        this.next(room);
        room.desired = "playing";
      }
      return;
    }
    if (type === "remove") {
      const item = room.queue.find((q) => q.id === p.id);
      requireValue(item, "reservation_not_found", 404);
      requireValue(host || item.owner === session.id, "forbidden", 403);
      room.queue = room.queue.filter((q) => q.id !== p.id);
      if (room.current && room.current.reservationId === p.id && !room.current.confirmed) {
        room.current = null;
        room.desired = "paused";
        room.observed = "ready";
        if (room.queue.length && this.available(room)) {
          this.next(room);
          room.desired = "playing";
        }
      }
      return;
    }
    requireValue(
      host ||
        (room.policy.guestControl && ["play", "pause", "skip", "volume", "tempo", "seek"].includes(type)),
      "forbidden",
      403,
    );
    switch (type) {
      case "reorder": {
        requireValue(
          Array.isArray(p.ids) &&
            p.ids.length === room.queue.length &&
            new Set(p.ids).size === room.queue.length &&
            p.ids.every((id) => room.queue.some((q) => q.id === id)),
        );
        room.queue = p.ids.map((id) => room.queue.find((q) => q.id === id)!);
        break;
      }
      case "play":
        requireValue(this.available(room), "display_unavailable", 409);
        if (!room.current) this.next(room);
        requireValue(room.current, "queue_empty", 409);
        room.desired = "playing";
        break;
      case "pause":
        room.desired = "paused";
        break;
      case "skip":
        requireValue(this.available(room), "display_unavailable", 409);
        if (room.current)
          room.queue = room.queue.filter(
            (q) => q.id !== room.current!.reservationId,
          );
        this.next(room);
        break;
      case "seek":
        requireValue(room.current, "queue_empty", 409);
        room.current.seek = { id: randomUUID(), position: number(p.position, 0,
          this.store.get("songs", room.current.songId)?.duration || 600) };
        room.position = room.current.seek.position;
        break;
      case "volume":
        room.volume = number(p.value, 0, 1);
        break;
      case "tempo":
        room.tempo = number(p.value, 0.5, 1.5);
        break;
      case "lock":
        requireValue(typeof p.locked === "boolean");
        room.status = p.locked ? "locked" : "open";
        break;
      case "policy":
        if (p.roomCap !== undefined) {
          room.policy.roomCap = Math.floor(number(p.roomCap, 1, 1000));
        }
        if (p.guestCap !== undefined)
          room.policy.guestCap = Math.floor(number(p.guestCap, 1, 100));
        if (p.guestControl !== undefined) {
          requireValue(typeof p.guestControl === "boolean");
          room.policy.guestControl = p.guestControl;
        }
        break;
      case "revoke": {
        const target = this.store
          .all("sessions")
          .find((s) => s.id === p.deviceId);
        requireValue(
          target &&
            target.role === "guest" &&
            room.members[target.id],
          "invalid_participant",
        );
        target.revoked = true;
        this.store.put("sessions", target.tokenHash, target);
        delete room.members[target.id];
        if (room.lease?.deviceId === target.id) {
          room.lease.releaseRequested = true;
          room.desired = "paused";
        }
        break;
      }
      case "end":
        room.status = "ended";
        room.desired = "paused";
        room.current = null;
        room.queue = [];
        if (room.lease) room.lease.releaseRequested = true;
        for (const s of this.store
          .all("sessions")
          .filter((s) => s.roomId === room.id)) {
          s.revoked = true;
          this.store.put("sessions", s.tokenHash, s);
        }
        room.members = {};
        break;
    }
  }
  next(room: Room) {
    const item = room.queue[0];
    room.current = item
      ? {
          ...item,
          reservationId: item.id,
          playbackId: randomUUID(),
          confirmed: false,
        }
      : null;
    room.position = 0;
    room.observed = item ? "loading" : "idle";
    if (!item) room.desired = "paused";
  }
  available(room: Room): room is Room & { lease: NonNullable<Room["lease"]> } {
    const lease = room.lease;
    return !!(
      lease &&
      !lease.retired &&
      !lease.releaseRequested &&
      (this.deadlines.get(lease.generation) || 0) > this.monotonic()
    );
  }
  claim(roomId: string, session: Session) {
    return this.store.transaction(() => {
      const room = this.room(roomId, session);
      requireValue(session.id === room.screenId, "main_screen_required", 403);
      requireValue(!this.available(room), "screen_already_started", 409);
      if (room.lease) this.deadlines.delete(room.lease.generation);
      room.lease = {
        deviceId: session.id, generation: randomUUID(),
        deadline: this.clock() + LIMITS.leaseMs,
        releaseRequested: false, retired: false,
      };
      this.deadlines.set(
        room.lease.generation,
        this.monotonic() + LIMITS.leaseMs,
      );
      room.members[session.id] = {
        nickname: session.nickname,
        role: session.role,
      };
      room.desired = "paused";
      room.observed = "ready";
      if (!room.current && room.queue.length) {
        this.next(room);
        room.desired = "playing";
      }
      if (room.current) room.current.seek = { id: randomUUID(), position: room.position };
      room.revision++;
      this.store.put("rooms", room.id, room);
      return {
        generation: room.lease.generation,
        leaseMs: LIMITS.leaseMs,
      };
    });
  }
  renew(roomId: string, session: Session, generation: string) {
    return this.store.transaction(() => {
      const room = this.room(roomId, session);
      requireValue(
        this.available(room) &&
          room.lease.deviceId === session.id &&
          room.lease.generation === generation,
        "stale_display",
        409,
      );
      room.lease.deadline = this.clock() + LIMITS.leaseMs;
      if (room.expires) room.expires = this.clock() + 24 * 60 * 60_000;
      session.expires = this.clock() + 24 * 60 * 60_000;
      this.store.put("sessions", session.tokenHash, session);
      if (room.pairing) {
        for (const id of [digest(room.pairing.code), digest(room.pairing.token)]) {
          const grant = this.store.get("invites", id);
          if (grant) { grant.expires = room.expires!; this.store.put("invites", id, grant); }
        }
      }
      this.store.put("rooms", room.id, room);
      this.deadlines.set(generation, this.monotonic() + LIMITS.leaseMs);
      return { generation, leaseMs: LIMITS.leaseMs };
    });
  }
  release(roomId: string, session: Session, generation: string) {
    const room = this.room(roomId, session);
    requireValue(session.id === room.screenId && room.lease?.generation === generation, "stale_display", 409);
    room.lease.retired = true;
    room.desired = "paused";
    room.observed = "unavailable";
    room.revision++;
    this.store.put("rooms", room.id, room);
    this.deadlines.delete(generation);
    return room;
  }
  telemetry(roomId: string, session: Session, message: Telemetry) {
    return this.store.transaction(() => {
      const room = this.room(roomId, session);
      requireValue(
        this.available(room) &&
          room.lease.deviceId === session.id &&
          room.lease.generation === message.leaseGeneration,
        "stale_display",
        409,
      );
      requireValue(
        room.current?.playbackId === message.playbackId,
        "stale_playback",
        409,
      );
      requireValue(
        [
          "loading",
          "ready",
          "playing",
          "paused",
          "buffering",
          "failed",
          "ended",
        ].includes(message.state),
      );
      if (message.score !== undefined) {
        requireValue(message.score && ["guide", "stability"].includes(message.score.mode));
        number(message.score.value, 0, 100);
        number(message.score.samples, 20, 1_000_000);
      }
      room.position = number(message.position, 0, 86_400);
      room.sampleTime = this.clock();
      room.observed = message.state;
      if (
        message.state === "playing" &&
        room.desired === "playing" &&
        !room.current.confirmed
      ) {
        room.queue = room.queue.filter(
          (q) => q.id !== room.current!.reservationId,
        );
        room.current.confirmed = true;
      }
      if (message.state === "ended") {
        requireValue(room.current.confirmed, "playback_unconfirmed", 409);
        if (message.score) room.scores = [...(room.scores || []), {
          playbackId: room.current.playbackId, title: room.current.title,
          nickname: room.current.nickname, value: message.score.value, mode: message.score.mode,
        }].slice(-20);
        this.next(room);
      }
      if (message.state === "failed") room.desired = "paused";
      room.revision++;
      this.store.put("rooms", room.id, room);
      return room;
    });
  }
}

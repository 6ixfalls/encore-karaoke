import type { Store } from "./store.js";
import type { Room, Session, Invitation, Command, CommandResult, Telemetry, Retirement } from "./types.js";
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
    return ["host", "admin"].includes(session.role);
  }
  room(id: string, session: Session | null, { ended = false } = {}) {
    const room = this.store.get("rooms", id);
    requireValue(
      room && (ended || room.status !== "ended"),
      "room_not_found",
      404,
    );
    requireValue(
      session && !session.revoked && session.epoch === this.store.authEpoch,
      "unauthorized",
      401,
    );
    requireValue(
      session.role === "admin" ||
        (this.host(session) &&
          room.ownerPrincipal &&
          room.ownerPrincipal === session.principal) ||
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
      ownerPrincipal: session.principal,
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
      seekable: !room.current || this.store.get("songs", room.current.songId)?.format !== "youtube",
      desired: room.desired,
      observed: room.observed,
      volume: room.volume,
      tempo: room.tempo,
      position: room.position,
      sampleTime: room.sampleTime,
      cheers: (room.cheers || []).filter((c) => this.clock() - c.time < 8000),
      scores: room.scores || [],
      policy: room.policy,
      recoveryRequired: !!room.recoveryRequired,
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
      roomId, epoch: this.store.authEpoch, kind: "guest",
      invitation: digest(room.pairing.token), code: digest(room.pairing.code),
      expires: room.expires || this.clock() + 24 * 60 * 60_000,
    };
    this.store.put("invites", grant.invitation, grant);
    this.store.put("invites", grant.code, grant);
    return { invitation: room.pairing.token, code: room.pairing.code, expires: grant.expires };
  }
  invite(roomId: string, session: Session, kind: unknown = "guest") {
    this.room(roomId, session);
    requireValue(this.host(session), "forbidden", 403);
    requireValue(kind === "guest" || kind === "display");
    const invitation = secret();
    let code;
    do {
      code = String(randomInt(100000, 1000000));
    } while (this.store.get("invites", digest(code)));
    const value: Invitation = {
      roomId,
      epoch: this.store.authEpoch,
      expires: this.clock() + 15 * 60_000,
      kind,
      invitation: digest(invitation),
      code: digest(code),
    };
    this.store.transaction(() => {
      for (const previous of this.store
        .all("invites")
        .filter((i) => i.roomId === roomId && i.kind === kind)) {
        this.store.delete("invites", previous.invitation);
        this.store.delete("invites", previous.code);
      }
      this.store.put("invites", value.invitation, value);
      if (kind === "guest") this.store.put("invites", value.code, value);
    });
    return {
      invitation,
      code: kind === "guest" ? code : undefined,
      expires: value.expires,
    };
  }
  join(invitation: unknown, session: Session) {
    return this.store.transaction(() => {
      const grant = this.store.get("invites", digest(text(invitation, 128)));
      requireValue(
        grant &&
          grant.epoch === this.store.authEpoch &&
          grant.expires > this.clock(),
        "expired_invitation",
        403,
      );
      const room = this.store.get("rooms", grant.roomId);
      requireValue(room && room.status === "open", "room_locked", 403);
      const activeMembers = new Set(
        this.store.all("sessions")
          .filter((s) => !s.revoked && s.epoch === this.store.authEpoch && s.expires > this.clock())
          .map((s) => s.id),
      );
      for (const id of Object.keys(room.members))
        if (!activeMembers.has(id)) delete room.members[id];
      requireValue(Object.keys(room.members).length < 200, "room_full", 409);
      session.role = grant.kind;
      session.roomId = room.id;
      room.members[session.id] = {
        nickname: session.nickname,
        role: session.role,
      };
      room.revision++;
      this.store.put("sessions", session.tokenHash, session);
      this.store.put("rooms", room.id, room);
      if (grant.kind === "display") {
        this.store.delete("invites", grant.invitation);
        this.store.delete("invites", grant.code);
      }
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
    // Separate namespaces keep general command budgets independent of enqueue admission.
    // Persist the budget so reconnects and process restarts cannot reset it.
    const attempts = this.store.db.prepare(
      "SELECT device,time FROM attempts WHERE room='commands' AND time>? ORDER BY time",
    ).all(now - LIMITS.windowMs);
    const own = attempts.filter((a) => a.device === device);
    if (own.length >= LIMITS.commandDeviceRate)
      return LIMITS.windowMs - (now - Number(own[0].time));
    if (attempts.length >= LIMITS.commandGlobalRate)
      return LIMITS.windowMs - (now - Number(attempts[0].time));
    // Over-budget requests return above without writing or caching another rejection.
    this.store.db.prepare("DELETE FROM attempts WHERE time<=?").run(now - LIMITS.windowMs);
    this.store.db.prepare("INSERT INTO attempts(device,room,time) VALUES(?,'commands',?)").run(device, now);
    return 0;
  }
  admit(room: Room, session: Session) {
    requireValue(session.role !== "display", "forbidden", 403);
    const db = this.store.db,
      now = this.clock();
    db.prepare("DELETE FROM attempts WHERE time<=?").run(now - LIMITS.windowMs);
    const device = db
      .prepare("SELECT time FROM attempts WHERE device=? ORDER BY time")
      .all(session.id);
    const total = db
      .prepare("SELECT time FROM attempts WHERE room=? ORDER BY time")
      .all(room.id);
    // Rejected fresh attempts count too; retain bounded rows per window to avoid an overload growing the database.
    const deviceLimited = device.length >= LIMITS.deviceRate,
      roomLimited = total.length >= LIMITS.roomRate;
    if (!deviceLimited && !roomLimited)
      db.prepare("INSERT INTO attempts(device,room,time) VALUES(?,?,?)").run(
        session.id,
        room.id,
        now,
      );
    else {
      // Refresh the oldest applicable attempt: continued abuse keeps the rolling window closed.
      db.prepare("INSERT INTO attempts(device,room,time) VALUES(?,?,?)").run(
        session.id,
        room.id,
        now,
      );
      db.prepare(
        "DELETE FROM attempts WHERE id IN (SELECT id FROM attempts WHERE room=? ORDER BY time DESC,id DESC LIMIT -1 OFFSET 200)",
      ).run(room.id);
      throw new Fault(
        "rate_limited",
        429,
        LIMITS.windowMs -
          Math.min(
            deviceLimited ? Number(device[0].time) : now,
            roomLimited ? Number(total[0].time) : now,
          ) +
          now,
      );
    }
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
      let song;
      if (p.youtube !== undefined) {
        const videoId = text(p.youtube, 11);
        requireValue(/^[a-zA-Z0-9_-]{11}$/.test(videoId), "invalid_youtube_id");
        song = { id: `yt:${videoId}`, title: text(p.title, 200), artist: "YouTube", format: "youtube" as const, videoId };
        this.store.put("songs", song.id, song);
      } else song = this.store.get("songs", text(p.songId, 100));
      requireValue(song, "song_not_found", 404);
      room.queue.push({
        id: randomUUID(),
        songId: song.id,
        title: song.title,
        artist: song.artist,
        owner: session.id,
        nickname: session.nickname,
      });
      return;
    }
    if (type === "cheer") {
      requireValue(session.role !== "display", "forbidden", 403);
      const message = text(p.message, 120);
      room.cheers = [...(room.cheers || []).filter((c) => this.clock() - c.time < 8000),
        { id: randomUUID(), nickname: session.nickname, message, time: this.clock() }].slice(-12);
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
        requireValue(room.current, "nothing_playing", 409);
        requireValue(this.store.get("songs", room.current.songId)?.format !== "youtube", "live_separation_not_seekable", 409);
        room.current.seek = {
          position: number(p.position, 0, 86_400),
          id: randomUUID(),
        };
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
          requireValue(session.role === "admin", "forbidden", 403);
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
            ["guest", "display"].includes(target.role) &&
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
      !room.recoveryRequired &&
      lease &&
      !lease.retired &&
      !lease.releaseRequested &&
      lease.epoch === this.store.deployment &&
      (this.deadlines.get(lease.generation) || 0) > this.monotonic()
    );
  }
  claim(roomId: string, session: Session) {
    return this.store.transaction(() => {
      const room = this.room(roomId, session);
      requireValue(
        this.host(session) || session.role === "display",
        "forbidden",
        403,
      );
      requireValue(!room.recoveryRequired, "physical_recovery_required", 409);
      if (room.lease && !room.lease.retired) {
        room.lease.releaseRequested = true;
        room.desired = "paused";
        room.revision++;
        this.store.put("rooms", room.id, room);
        return { pending: true };
      }
      const releaseToken = secret();
      room.lease = {
        deviceId: session.id,
        generation: `${this.store.deployment}:${randomUUID()}`,
        epoch: this.store.deployment,
        deadline: this.clock() + LIMITS.leaseMs,
        releaseHash: digest(releaseToken),
        releaseRequested: false,
        retired: false,
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
      if (room.current) {
        if (this.store.get("songs", room.current.songId)?.format === "youtube") {
          // A replacement display opens a new sequential separation stream.
          room.position = 0;
          delete room.current.seek;
        } else {
          room.current.seek = { position: room.position || 0, id: randomUUID() };
        }
      }
      room.revision++;
      this.store.put("rooms", room.id, room);
      return {
        generation: room.lease.generation,
        leaseMs: LIMITS.leaseMs,
        releaseToken,
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
      this.store.put("rooms", room.id, room); // Commit before the grant is returned to the browser.
      this.deadlines.set(generation, this.monotonic() + LIMITS.leaseMs);
      return { generation, leaseMs: LIMITS.leaseMs };
    });
  }
  release(roomId: string, generation: string, token: unknown) {
    const room = this.store.get("rooms", roomId);
    requireValue(
      room?.lease?.generation === generation &&
        room.lease.releaseHash === digest(text(token, 128)),
      "invalid_release",
      403,
    );
    room.lease.retired = true;
    room.desired = "paused";
    room.observed = "unavailable";
    room.revision++;
    this.store.put("rooms", room.id, room);
    this.deadlines.delete(generation);
    return room;
  }
  retire(roomId: string, session: Session, confirmation: Retirement) {
    requireValue(session.role === "admin", "forbidden", 403);
    const room = this.room(roomId, session, { ended: true });
    requireValue(
      confirmation?.generation === (room.lease?.generation || "recovery") &&
        confirmation.outputsPhysicallyIsolated === true &&
        confirmation.browserTerminatedAndPairingCleared === true &&
        (!room.recoveryRequired ||
          confirmation.allPossiblyOutstandingDisplaysIsolated === true),
      "physical_confirmation_required",
    );
    this.store.transaction(() => {
      for (const device of this.store.all("sessions")) {
        if (
          (device.roomId === roomId && device.role === "display") ||
          device.id === room.lease?.deviceId
        ) {
          device.revoked = true;
          this.store.put("sessions", device.tokenHash, device);
          delete room.members[device.id];
        }
      }
      if (room.lease) room.lease.retired = true;
      room.recoveryRequired = false;
      room.desired = "paused";
      room.observed = "unavailable";
      room.revision++;
      this.store.put("rooms", room.id, room);
      this.store.db
        .prepare("INSERT INTO audit(value) VALUES(?)")
        .run(
          JSON.stringify({
            type: "physical_retirement",
            roomId,
            administrator: session.id,
            time: this.clock(),
            confirmation,
          }),
        );
    });
    if (room.lease) this.deadlines.delete(room.lease.generation);
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

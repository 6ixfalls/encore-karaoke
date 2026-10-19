import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../server/store.mjs";
import { Rooms } from "../../server/rooms.mjs";
import { Auth } from "../../server/auth.mjs";
import { backup, restore, lock } from "../../server/operations.mjs";
import { parseLrc } from "../../src/hosted/lrc.js";

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "encore-test-"));
  let store = new Store(directory);
  const config = {
    adminKey: "a".repeat(32),
    hostKey: "h".repeat(32),
    secure: false,
  };
  let auth = new Auth(store, config);
  let now = Date.now(),
    tick = 100;
  let rooms = new Rooms(store, { clock: () => now, monotonic: () => tick });
  const admin = auth.create("admin", "Admin").session;
  const host = auth.create("host", "Host").session;
  const room = rooms.create(host, "Test room");
  const song = {
    id: "song-1",
    title: "<img src=x onerror=alert(1)>",
    artist: "Artist",
    assetId: "a".repeat(64),
  };
  store.put("songs", song.id, song);
  const guest = () => {
    const session = auth.create("guest", "<script>alert(1)</script>").session;
    rooms.join(rooms.invite(room.id, host).invitation, session);
    return session;
  };
  let seq = 0;
  const command = (session, type, payload = {}, extra = {}) =>
    rooms.command(room.id, session, {
      commandId: `c-${++seq}`,
      type,
      payload,
      ...extra,
    });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    config,
    admin,
    host,
    room,
    song,
    guest,
    command,
    get store() {
      return store;
    },
    get rooms() {
      return rooms;
    },
    get auth() {
      return auth;
    },
    advance(ms) {
      now += ms;
      tick += ms;
    },
    wallJump(ms) {
      now += ms;
    },
    restart() {
      store.close();
      store = new Store(directory);
      auth = new Auth(store, config);
      rooms = new Rooms(store, { clock: () => now, monotonic: () => tick });
    },
    restore(source) {
      store.close();
      restore(directory, source);
      store = new Store(directory);
      auth = new Auth(store, config);
      rooms = new Rooms(store, { clock: () => now, monotonic: () => tick });
    },
  };
}

test("guest allowances, room limits, rejection revisions, deduplication, and capacity release", (t) => {
  const f = setup(t),
    guest = f.guest();
  f.command(f.admin, "policy", { guestCap: 2, roomCap: 3 });
  const request = {
    commandId: "retry",
    type: "enqueue",
    payload: { songId: f.song.id },
  };
  const first = f.rooms.command(f.room.id, guest, request);
  assert.equal(first.accepted, true);
  assert.deepEqual(f.rooms.command(f.room.id, guest, request), first);
  f.command(guest, "enqueue", { songId: f.song.id });
  const before = f.store.get("rooms", f.room.id).revision;
  assert.equal(
    f.command(guest, "enqueue", { songId: f.song.id }).error,
    "reservation_limit",
  );
  assert.equal(f.store.get("rooms", f.room.id).revision, before);
  f.command(f.host, "enqueue", { songId: f.song.id });
  assert.equal(
    f.command(f.host, "enqueue", { songId: f.song.id }).error,
    "queue_full",
  );
  f.command(f.admin, "policy", { roomCap: 1 });
  assert.equal(f.store.get("rooms", f.room.id).queue.length, 3);
  const queue = f.store.get("rooms", f.room.id).queue;
  f.command(guest, "remove", { id: queue[0].id });
  f.command(f.host, "remove", { id: queue[1].id });
  f.command(f.host, "remove", { id: queue[2].id });
  f.advance(10_001);
  assert.equal(
    f.command(guest, "enqueue", { songId: f.song.id }).accepted,
    true,
  );
});

test("attempts include rejections, survive restarts, and accepted retries bypass rate checks", (t) => {
  const f = setup(t),
    guest = f.guest();
  const request = {
    commandId: "same",
    type: "enqueue",
    payload: { songId: f.song.id },
  };
  const original = f.rooms.command(f.room.id, guest, request);
  for (let i = 0; i < 4; i++)
    f.command(guest, "enqueue", { songId: "missing" });
  const rejected = f.command(guest, "enqueue", { songId: f.song.id });
  assert.equal(rejected.error, "rate_limited");
  assert.ok(rejected.retryAfterMs > 0 && rejected.retryAfterMs <= 10_000);
  f.restart();
  assert.deepEqual(f.rooms.command(f.room.id, guest, request), original);
  assert.equal(
    f.command(guest, "enqueue", { songId: f.song.id }).error,
    "rate_limited",
  );
  assert.throws(
    () =>
      f.rooms.command(f.room.id, guest, {
        ...request,
        payload: { songId: "different" },
      }),
    /command_id_reused/,
  );
  f.advance(10_001);
  assert.equal(
    f.command(guest, "enqueue", { songId: f.song.id }).accepted,
    true,
  );
});

test("room rate cannot be bypassed by newly joined devices or hosts", (t) => {
  const f = setup(t);
  for (let i = 0; i < 4; i++) {
    const guest = f.guest();
    for (let n = 0; n < 5; n++)
      assert.equal(
        f.command(guest, "enqueue", { songId: f.song.id }).accepted,
        true,
      );
  }
  assert.equal(
    f.command(f.guest(), "enqueue", { songId: f.song.id }).error,
    "rate_limited",
  );
  assert.equal(
    f.command(f.host, "enqueue", { songId: f.song.id }).error,
    "rate_limited",
  );
  assert.equal(f.store.get("rooms", f.room.id).queue.length, 20);
});

test("permissions and revision conflicts preserve state across rooms", (t) => {
  const f = setup(t),
    guest = f.guest(),
    other = f.auth.create(
      "host",
      "Other host",
      "separate-host-principal",
    ).session;
  const otherRoom = f.rooms.create(other, "Other room");
  assert.throws(() => f.rooms.room(otherRoom.id, guest), /forbidden/);
  assert.throws(() => f.rooms.room(f.room.id, other), /forbidden/);
  assert.equal(f.command(guest, "volume", { value: 0.9 }).error, "forbidden");
  assert.equal(f.command(guest, "policy", { guestCap: 90 }).error, "forbidden");
  assert.equal(f.command(f.host, "policy", { roomCap: 90 }).error, "forbidden");
  f.command(guest, "enqueue", { songId: f.song.id });
  const q = f.store.get("rooms", f.room.id).queue[0];
  assert.equal(f.command(f.guest(), "remove", { id: q.id }).error, "forbidden");
  assert.equal(
    f.command(f.host, "remove", { id: q.id }, { expectedRevision: -1 }).error,
    "revision_conflict",
  );
  assert.equal(f.store.get("rooms", f.room.id).queue.length, 1);
});

test("confirmation, stale telemetry, and repeated ends never duplicate transitions", (t) => {
  const f = setup(t),
    guest = f.guest();
  f.command(guest, "enqueue", { songId: f.song.id });
  const grant = f.rooms.claim(f.room.id, f.host);
  assert.equal(f.command(f.host, "play").accepted, true);
  const current = f.store.get("rooms", f.room.id).current;
  assert.equal(f.store.get("rooms", f.room.id).queue.length, 1);
  const report = (state) => ({
    leaseGeneration: grant.generation,
    playbackId: current.playbackId,
    state,
    position: 1,
  });
  assert.throws(
    () => f.rooms.telemetry(f.room.id, guest, report("playing")),
    /stale_display/,
  );
  f.rooms.telemetry(f.room.id, f.host, report("playing"));
  assert.equal(f.store.get("rooms", f.room.id).queue.length, 0);
  f.command(guest, "enqueue", { songId: f.song.id });
  f.rooms.telemetry(f.room.id, f.host, report("ended"));
  const next = f.store.get("rooms", f.room.id).current.playbackId;
  assert.notEqual(next, current.playbackId);
  assert.throws(
    () => f.rooms.telemetry(f.room.id, f.host, report("ended")),
    /stale_playback/,
  );
  assert.equal(f.store.get("rooms", f.room.id).current.playbackId, next);
  assert.throws(
    () => f.rooms.telemetry(f.room.id, f.host, {
      ...report("playing"),
      playbackId: next,
      leaseGeneration: "obsolete-generation",
    }),
    /stale_display/,
  );
});

test("acknowledgment-only takeover blocks beyond expiry, wall jumps, and restart", (t) => {
  const f = setup(t);
  const old = f.rooms.claim(f.room.id, f.host);
  f.wallJump(86_400_000);
  assert.ok(f.rooms.available(f.store.get("rooms", f.room.id))); // server authority uses monotonic time
  f.advance(20_000);
  assert.equal(f.rooms.claim(f.room.id, f.admin).pending, true);
  f.restart();
  assert.equal(f.store.get("rooms", f.room.id).desired, "paused");
  assert.equal(f.rooms.claim(f.room.id, f.admin).pending, true);
  assert.throws(
    () => f.rooms.renew(f.room.id, f.host, old.generation),
    /stale_display/,
  );
  f.rooms.release(f.room.id, old.generation, old.releaseToken);
  const replacement = f.rooms.claim(f.room.id, f.admin);
  assert.notEqual(replacement.generation, old.generation);
  assert.throws(
    () => f.rooms.release(f.room.id, replacement.generation, old.releaseToken),
    /invalid_release/,
  );
});

test("physical retirement requires administrator confirmation, revokes pairing, and preserves queue", (t) => {
  const f = setup(t),
    guest = f.guest();
  f.command(guest, "enqueue", { songId: f.song.id });
  const display = f.auth.create("guest", "Display").session;
  f.rooms.join(
    f.rooms.invite(f.room.id, f.host, "display").invitation,
    display,
  );
  const old = f.rooms.claim(f.room.id, display);
  const confirmation = {
    generation: old.generation,
    outputsPhysicallyIsolated: true,
    browserTerminatedAndPairingCleared: true,
  };
  assert.throws(
    () => f.rooms.retire(f.room.id, f.host, confirmation),
    /forbidden/,
  );
  assert.throws(
    () =>
      f.rooms.retire(f.room.id, f.admin, {
        ...confirmation,
        outputsPhysicallyIsolated: false,
      }),
    /physical_confirmation_required/,
  );
  f.rooms.retire(f.room.id, f.admin, confirmation);
  assert.equal(f.store.get("sessions", display.tokenHash).revoked, true);
  assert.equal(f.store.get("rooms", f.room.id).queue.length, 1);
  assert.equal(f.store.get("rooms", f.room.id).desired, "paused");
  f.restart();
  assert.equal(f.store.get("rooms", f.room.id).lease.retired, true);
});

test("backup and restore rotate authentication, fence even grants newer than backup, and preserve backup", (t) => {
  const f = setup(t),
    guest = f.guest();
  const invitation = f.rooms.invite(f.room.id, f.host);
  f.command(guest, "enqueue", { songId: f.song.id });
  const source = path.join(f.directory, "snapshot");
  const metadata = backup(f.directory, source);
  const beforeEpoch = f.store.authEpoch;
  const later = f.rooms.claim(f.room.id, f.host);
  f.restore(source);
  assert.notEqual(f.store.authEpoch, beforeEpoch);
  assert.equal(f.store.all("sessions").length, 0);
  assert.equal(f.store.all("invites").length, 0);
  assert.equal(f.store.get("rooms", f.room.id).queue.length, 1);
  const admin = f.auth.create("admin", "Recovered admin").session;
  assert.throws(
    () => f.rooms.claim(f.room.id, admin),
    /physical_recovery_required/,
  );
  assert.throws(
    () =>
      f.rooms.join(invitation.code, f.auth.create("guest", "Guest").session),
    /expired_invitation/,
  );
  assert.throws(
    () => f.rooms.renew(f.room.id, admin, later.generation),
    /stale_display/,
  );
  f.rooms.retire(f.room.id, admin, {
    generation: "recovery",
    outputsPhysicallyIsolated: true,
    browserTerminatedAndPairingCleared: true,
    allPossiblyOutstandingDisplaysIsolated: true,
  });
  assert.ok(f.rooms.claim(f.room.id, admin).generation);
  const epoch = f.store.authEpoch;
  f.restart();
  assert.equal(f.store.authEpoch, epoch);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(source, "backup.json"), "utf8"))
      .sha256,
    metadata.sha256,
  );
});

test("a pre-restore release token can only retire its recorded generation", (t) => {
  const f = setup(t),
    old = f.rooms.claim(f.room.id, f.host);
  const source = path.join(f.directory, "snapshot");
  backup(f.directory, source);
  f.restore(source);
  f.rooms.release(f.room.id, old.generation, old.releaseToken);
  assert.equal(f.store.get("rooms", f.room.id).lease.retired, true);
  const admin = f.auth.create("admin", "Admin").session;
  assert.throws(
    () => f.rooms.claim(f.room.id, admin),
    /physical_recovery_required/,
  ); // backup may omit another device
});

test("corrupt backup and active-server restore are rejected without altering the database", (t) => {
  const f = setup(t),
    source = path.join(f.directory, "snapshot");
  backup(f.directory, source);
  const unlock = lock(f.directory);
  assert.throws(() => restore(f.directory, source), /Stop the Encore server/);
  unlock();
  fs.appendFileSync(path.join(source, "encore.sqlite"), "corrupt");
  assert.throws(() => restore(f.directory, source), /backup_checksum_mismatch/);
  assert.equal(f.store.get("rooms", f.room.id).name, "Test room");
});

test("room capacity counts active sessions and prunes stale memberships on join", t => {
  const f = setup(t);
  const room = f.store.get("rooms", f.room.id);
  const members = [];
  for (let i = 0; i < 199; i++) {
    const member = f.auth.create("guest", `Guest ${i}`).session;
    members.push(member);
    room.members[member.id] = { nickname: member.nickname, role: member.role };
  }
  f.store.put("rooms", room.id, room);
  const invitation = f.rooms.invite(room.id, f.host).invitation;
  const newcomer = f.auth.create("guest", "New guest").session;
  assert.throws(() => f.rooms.join(invitation, newcomer), /room_full/);
  members[0].revoked = true;
  members[1].expires = 0;
  members[2].epoch = "old-epoch";
  for (const member of members.slice(0, 3)) f.store.put("sessions", member.tokenHash, member);
  f.store.delete("sessions", members[3].tokenHash);
  const joined = f.rooms.join(invitation, newcomer);
  assert.equal(Object.keys(joined.members).length, 197);
  assert.ok(joined.members[newcomer.id]);
  for (const member of members.slice(0, 4)) assert.equal(joined.members[member.id], undefined);
});

test("invitations expire, rotate, lock, and bind to the authentication epoch", (t) => {
  const f = setup(t),
    first = f.rooms.invite(f.room.id, f.host),
    second = f.rooms.invite(f.room.id, f.host);
  const session = f.auth.create("guest", "Guest").session;
  assert.throws(
    () => f.rooms.join(first.invitation, session),
    /expired_invitation/,
  );
  f.command(f.host, "lock", { locked: true });
  assert.throws(() => f.rooms.join(second.code, session), /room_locked/);
  f.command(f.host, "lock", { locked: false });
  f.advance(15 * 60_000 + 1);
  assert.throws(
    () => f.rooms.join(second.invitation, session),
    /expired_invitation/,
  );
});

test("LRC parser shares desktop timing and supports repeated timestamps, offsets, and literal text", () => {
  assert.deepEqual(
    parseLrc(
      "[offset:-100]\n[00:01.2][00:03.456]<img onerror=x>\n[00:02]Second\n[ar:metadata]",
    ),
    [
      { time: 1.0999999999999999, text: "<img onerror=x>" },
      { time: 1.9, text: "Second" },
      { time: 3.356, text: "<img onerror=x>" },
    ],
  );
});

test("fresh host login retains room ownership, and cancelling a loading reservation stops its playback intent", t => {
  const f = setup(t), guest = f.guest();
  const hostLogin = f.auth.create("host", "Host again").session;
  assert.equal(f.rooms.room(f.room.id, hostLogin).id, f.room.id);
  f.command(guest, "enqueue", { songId: f.song.id });
  f.rooms.claim(f.room.id, f.host);
  f.command(f.host, "play");
  const loading = f.store.get("rooms", f.room.id);
  assert.equal(loading.current.confirmed, false);
  f.command(guest, "remove", { id: loading.current.reservationId });
  const stopped = f.store.get("rooms", f.room.id);
  assert.equal(stopped.current, null); assert.equal(stopped.desired, "paused"); assert.equal(stopped.queue.length, 0);
});

test("fresh forbidden commands are bounded across restarts while cached retries remain usable", t => {
  const f = setup(t), guest = f.guest();
  const accepted = { commandId: "accepted", type: "enqueue", payload: { songId: f.song.id } };
  const original = f.rooms.command(f.room.id, guest, accepted);
  const denied = { commandId: "denied", type: "pause" };
  const rejection = f.rooms.command(f.room.id, guest, denied);
  for (let i = 0; i < 1000; i++) f.command(guest, "pause");
  assert.equal(f.store.all("commands").length, 20);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM attempts WHERE room='commands'").get().n, 20);
  f.restart();
  assert.equal(f.command(guest, "pause").error, "rate_limited");
  assert.equal(f.store.all("commands").length, 20);
  assert.deepEqual(f.rooms.command(f.room.id, guest, accepted), original);
  assert.deepEqual(f.rooms.command(f.room.id, guest, denied), JSON.parse(JSON.stringify(rejection)));
  const firstRecords = f.store.all("commands");
  assert.equal(
    firstRecords.find(c => c.result.commandId === "accepted").expires -
      firstRecords.find(c => c.result.commandId === "denied").expires,
    86_400_000 - 60_000,
  );
  f.advance(10_001);
  assert.equal(f.command(guest, "pause").error, "forbidden");
});

test("new devices cannot bypass the global command budget", t => {
  const f = setup(t);
  for (let device = 0; device < 5; device++) {
    const guest = f.guest();
    for (let i = 0; i < 20; i++) assert.equal(f.command(guest, "pause").error, "forbidden");
  }
  const guest = f.guest();
  assert.equal(f.command(guest, "pause").error, "rate_limited");
  assert.equal(f.store.all("commands").length, 100);
  f.advance(10_001);
  assert.equal(f.command(guest, "pause").error, "forbidden");
});

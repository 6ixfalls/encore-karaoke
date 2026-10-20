import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../../dist/server/store.js";
import { Rooms } from "../../dist/server/rooms.js";
import { Participants } from "../../dist/server/participants.js";
import { configuration } from "../../dist/server/config.js";

function fixture(t) {
  const store = new Store(), participants = new Participants(store, configuration());
  let now = Date.now(), mono = 100;
  const rooms = new Rooms(store, { clock: () => now, monotonic: () => mono });
  const host = participants.create("host", "Main screen").session;
  const room = rooms.create(host, "Karaoke");
  host.roomId = room.id; store.put("sessions", host.tokenHash, host);
  const pairing = rooms.pairing(room.id, host);
  const guest = () => {
    const member = participants.create("guest", "Singer").session;
    rooms.join(pairing.code, member);
    return member;
  };
  const command = (session, type, payload = {}, extra = {}) => rooms.command(room.id, session, {
    commandId: randomUUID(), type, payload, ...extra,
  });
  const enqueue = (session = host, extra = {}) => command(session, "enqueue", { youtube: "M7lc1UVf-VE", title: "Song" }, extra);
  const state = () => store.get("rooms", room.id);
  t.after(() => store.close());
  return { store, participants, rooms, room, host, pairing, guest, command, enqueue, state,
    advance(ms) { now += ms; mono += ms; } };
}

test("code and QR grant join the same room and cannot grant main-screen ownership", t => {
  const f = fixture(t), a = f.guest(), b = f.participants.create("guest", "QR singer").session;
  f.rooms.join(f.pairing.invitation, b);
  assert.match(f.pairing.code, /^\d{6}$/);
  assert.deepEqual(f.rooms.pairing(f.room.id, f.host), f.pairing);
  assert.equal(f.state().screenId, f.host.id);
  for (const member of [a, b]) {
    assert.equal(member.role, "guest");
    assert.throws(() => f.rooms.claim(f.room.id, member), /main_screen_required/);
    assert.throws(() => f.rooms.pairing(f.room.id, member), /forbidden/);
  }
});

test("only one main screen can run; competing starts do not stop it", t => {
  const f = fixture(t), first = f.rooms.claim(f.room.id, f.host);
  assert.throws(() => f.rooms.claim(f.room.id, f.host), /screen_already_started/);
  assert.equal(f.state().lease.releaseRequested, false);
  assert.equal(f.rooms.renew(f.room.id, f.host, first.generation).generation, first.generation);
  f.rooms.release(f.room.id, f.host, first.generation);
  const next = f.rooms.claim(f.room.id, f.host);
  assert.notEqual(next.generation, first.generation);
  assert.throws(() => f.rooms.renew(f.room.id, f.host, first.generation), /stale_display/);
  assert.throws(() => f.rooms.release(f.room.id, f.host, first.generation), /stale_display/);
});

test("a timed-out screen can start again without administrator recovery", t => {
  const f = fixture(t), first = f.rooms.claim(f.room.id, f.host);
  f.advance(10_001);
  assert.equal(f.rooms.available(f.state()), false);
  assert.throws(() => f.rooms.renew(f.room.id, f.host, first.generation), /stale_display/);
  assert.notEqual(f.rooms.claim(f.room.id, f.host).generation, first.generation);
  assert.throws(() => f.rooms.claim(f.room.id, f.guest()), /main_screen_required/);
});

test("restart loses rooms, codes, participants, commands and songs", t => {
  const f = fixture(t), token = f.participants.create("guest", "Guest").token;
  f.enqueue();
  const empty = new Store(), rooms = new Rooms(empty), participants = new Participants(empty, configuration());
  t.after(() => empty.close());
  for (const table of ["rooms", "songs", "sessions", "invites", "commands"]) assert.deepEqual(empty.all(table), []);
  assert.equal(participants.session(token), null);
  assert.throws(() => rooms.room(f.room.id, f.host), /room_not_found/);
  assert.throws(() => rooms.join(f.pairing.code, participants.create("guest", "New guest").session), /expired_invitation/);
});

test("queue confirmation and stale playback IDs cannot double-advance", t => {
  const f = fixture(t), grant = f.rooms.claim(f.room.id, f.host);
  f.enqueue(); f.enqueue(); f.command(f.host, "play");
  const current = f.state().current;
  assert.equal(f.state().queue.length, 2);
  const report = { leaseGeneration: grant.generation, playbackId: current.playbackId, position: 1, state: "playing" };
  f.rooms.telemetry(f.room.id, f.host, report);
  f.rooms.telemetry(f.room.id, f.host, report);
  assert.equal(f.state().queue.length, 1);
  f.rooms.telemetry(f.room.id, f.host, { ...report, state: "ended", score: { mode: "guide", value: 90, samples: 20 } });
  assert.equal(f.state().scores.length, 1);
  const next = f.state().current.playbackId;
  assert.notEqual(next, report.playbackId);
  assert.throws(() => f.rooms.telemetry(f.room.id, f.host, { ...report, state: "ended" }), /stale_playback/);
  assert.equal(f.state().current.playbackId, next);
});

test("command retries are deduplicated and mismatched IDs rejected in memory", t => {
  const f = fixture(t), id = randomUUID();
  const first = f.enqueue(f.host, { commandId: id });
  assert.deepEqual(f.enqueue(f.host, { commandId: id }), first);
  assert.equal(f.state().queue.length, 1);
  assert.throws(() => f.command(f.host, "pause", {}, { commandId: id }), /command_id_reused/);
  assert.equal(f.enqueue(f.host, { expectedRevision: 100 }).error, "revision_conflict");
});

test("guest limits, ownership, room controls and command admission remain enforced", t => {
  const f = fixture(t), a = f.guest(), b = f.guest();
  f.command(f.host, "policy", { guestCap: 1 });
  assert.equal(f.enqueue(a).accepted, true);
  f.advance(10_001);
  assert.equal(f.enqueue(a).error, "reservation_limit");
  assert.equal(f.command(b, "remove", { id: f.state().queue[0].id }).error, "forbidden");
  assert.equal(f.command(a, "end").error, "forbidden");
  assert.equal(f.command(a, "play").error, "forbidden");
  for (let i = 0; i < 20; i++) f.command(f.host, "pause");
  const before = f.store.all("commands").length;
  assert.equal(f.command(f.host, "pause").status, 429);
  assert.equal(f.store.all("commands").length, before);
  f.advance(10_001);
  assert.equal(f.command(f.host, "pause").accepted, true);
});

test("expired records are swept and transactions isolate callers and roll back errors", t => {
  const f = fixture(t);
  const copy = f.state(); copy.queue.push({ id: "mutated" });
  assert.equal(f.state().queue.length, 0);
  assert.throws(() => f.store.transaction(() => { f.store.delete("rooms", f.room.id); throw new Error("rollback"); }));
  assert.ok(f.state());
  f.enqueue(); f.store.sweep(Date.now() + 2 * 86_400_000);
  assert.equal(f.store.all("commands").length, 0);
  assert.equal(f.store.all("sessions").length, 0);
  assert.equal(f.store.all("invites").length, 0);
});

test("ending and locking invalidate joins while guests cannot access other rooms", t => {
  const f = fixture(t), guest = f.guest();
  const other = f.rooms.create(f.participants.create("host", "Other screen").session, "Other");
  assert.throws(() => f.rooms.room(other.id, guest), /forbidden/);
  f.command(f.host, "lock", { locked: true });
  assert.throws(f.guest, /room_locked/);
  f.command(f.host, "end");
  assert.throws(f.guest, /room_locked/);
  assert.equal(f.participants.session("not-a-token"), null);
});

test("seek preserves pause state and playback identity, and reclaim restores the saved position", t => {
  const f = fixture(t);
  const grant = f.rooms.claim(f.room.id, f.host);
  f.enqueue();
  f.command(f.host, "play");
  const playbackId = f.state().current.playbackId;
  f.command(f.host, "pause");
  assert.equal(f.command(f.host, "seek", { position: 42.25 }).accepted, true);
  assert.equal(f.state().position, 42.25);
  assert.equal(f.state().desired, "paused");
  assert.equal(f.state().current.playbackId, playbackId);
  assert.equal(f.state().current.seek.position, 42.25);
  const seekId = f.state().current.seek.id;
  f.command(f.host, "play");
  assert.equal(f.state().current.seek.id, seekId);
  assert.equal(f.command(f.host, "seek", { position: 601 }).accepted, false);
  f.rooms.release(f.room.id, f.host, grant.generation);
  f.rooms.claim(f.room.id, f.host);
  assert.equal(f.state().position, 42.25);
  assert.equal(f.state().current.seek.position, 42.25);
  assert.notEqual(f.state().current.seek.id, seekId);
});

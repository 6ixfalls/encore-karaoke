import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { migrate, MIGRATIONS } from "../../dist/server/schema.js";
import { Store } from "../../dist/server/store.js";
import { backup, restore, lock } from "../../dist/server/operations.js";

function versionOne(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "encore-schema-")),
    filename = path.join(directory, "encore.sqlite");
  const db = new DatabaseSync(filename);
  db.exec(`${MIGRATIONS[0]} PRAGMA user_version=1;`);
  db.prepare("INSERT INTO meta(key,value) VALUES('authEpoch',?)").run(
    JSON.stringify("previous-epoch"),
  );
  db.prepare("INSERT INTO songs(id,value) VALUES('song',?)").run(
    JSON.stringify({ id: "song", title: "Preserved", artist: "Singer" }),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { db, directory, filename };
}
test("schema upgrade verifies a recoverable snapshot before adding indexes", (t) => {
  const { db, directory } = versionOne(t);
  migrate(db, directory);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
  assert.ok(
    db
      .prepare("SELECT name FROM sqlite_master WHERE name='commands_expiry'")
      .get(),
  );
  assert.equal(
    JSON.parse(db.prepare("SELECT value FROM songs").get().value).title,
    "Preserved",
  );
  db.close();
  const [snapshot] = fs.readdirSync(path.join(directory, "backups"));
  const before = new DatabaseSync(
    path.join(directory, "backups", snapshot, "encore.sqlite"),
    { readOnly: true },
  );
  assert.equal(before.prepare("PRAGMA user_version").get().user_version, 1);
  before.close();
});
test("a failed migration rolls back schema and data, and its original backup remains usable", (t) => {
  const { db, directory } = versionOne(t);
  assert.throws(
    () =>
      migrate(db, directory, [
        MIGRATIONS[0],
        "DELETE FROM songs; CREATE TABLE partial(id); SELECT missing FROM nonexistent;",
      ]),
    /no such table/,
  );
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM songs").get().n, 1);
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE name='partial'").get(),
    undefined,
  );
  db.close();
  const [snapshot] = fs.readdirSync(path.join(directory, "backups"));
  restore(directory, path.join(directory, "backups", snapshot));
  const recovered = new Store(directory);
  assert.notEqual(recovered.authEpoch, "previous-epoch");
  assert.equal(recovered.all("songs")[0].title, "Preserved");
  assert.equal(
    recovered.db.prepare("PRAGMA user_version").get().user_version,
    2,
  );
  recovered.close();
});
test("rollback from an unsupported future schema archives that database and restores a compatible snapshot", (t) => {
  const { db, directory } = versionOne(t);
  migrate(db, directory);
  db.close();
  const snapshot = path.join(directory, "working-backup");
  backup(directory, snapshot);
  const newer = new DatabaseSync(path.join(directory, "encore.sqlite"));
  newer.exec("PRAGMA user_version=99; CREATE TABLE failed_upgrade(id);");
  newer.close();
  assert.throws(() => new Store(directory), /unsupported_schema/);
  restore(directory, snapshot);
  const recovered = new Store(directory);
  assert.equal(
    recovered.db.prepare("PRAGMA user_version").get().user_version,
    2,
  );
  assert.equal(recovered.all("songs")[0].title, "Preserved");
  recovered.close();
  const archived = fs
    .readdirSync(directory)
    .find((name) => name.startsWith("before-restore-"));
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(directory, archived, "backup.json"), "utf8"),
    ).schema,
    99,
  );
});

test("process interruption before migration commit restores the original schema and contents", t => {
  const { db, directory, filename } = versionOne(t);
  db.close();
  const snapshot = path.join(directory, "before-interrupted-upgrade"); backup(directory, snapshot);
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN IMMEDIATE; DELETE FROM songs; CREATE TABLE interrupted(id); PRAGMA user_version=2;');
    process.kill(process.pid, 'SIGKILL');
  `, filename]);
  assert.equal(result.signal, "SIGKILL");
  const reopened = new DatabaseSync(filename);
  assert.equal(reopened.prepare("PRAGMA user_version").get().user_version, 1);
  assert.equal(reopened.prepare("SELECT count(*) AS n FROM songs").get().n, 1);
  assert.equal(reopened.prepare("SELECT name FROM sqlite_master WHERE name='interrupted'").get(), undefined);
  reopened.close();
  restore(directory, snapshot);
  const recovered = new Store(directory);
  assert.notEqual(recovered.authEpoch, "previous-epoch");
  assert.equal(recovered.all("songs")[0].title, "Preserved"); recovered.close();
});

test("the singleton lock excludes another process and is released automatically on a crash", t => {
  const { db, directory } = versionOne(t);
  db.close();
  const moduleUrl = new URL("../../dist/server/operations.js", import.meta.url).href;
  const child = `import { lock } from ${JSON.stringify(moduleUrl)}; lock(process.argv[1]);`;
  const unlock = lock(directory);
  const blocked = spawnSync(process.execPath, ["--input-type=module", "-e", child, directory]);
  assert.notEqual(blocked.status, 0); assert.match(blocked.stderr.toString(), /Stop the Encore server/);
  unlock();
  const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", `${child} process.kill(process.pid, 'SIGKILL');`, directory]);
  assert.equal(crashed.signal, "SIGKILL");
  lock(directory)();
});

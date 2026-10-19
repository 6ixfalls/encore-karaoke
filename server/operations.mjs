import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { secret } from "./secrets.mjs";
import { SCHEMA_VERSION, requireValue } from "../shared/contracts.js";

export function assertStopped(directory) {
  const unlock = lock(directory);
  unlock();
}
export function lock(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Kernel-backed SQLite locks work across container PID namespaces and release on
  // crashes. A PID file can mistake a new container's PID 1 for the old server.
  const db = new DatabaseSync(path.join(directory, "server-lock.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS singleton(id INTEGER); BEGIN EXCLUSIVE;");
  } catch (error) {
    db.close();
    if (error.errcode === 5 || error.message.includes("locked")) throw new Error("Stop the Encore server before this operation", { cause: error });
    throw error;
  }
  return () => { db.exec("ROLLBACK"); db.close(); };
}
function sync(filename) {
  const fd = fs.openSync(filename, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function checksum(filename) {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}
function validate(filename, { supportedSchema = true } = {}) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    requireValue(
      db.prepare("PRAGMA integrity_check").get().integrity_check === "ok",
      "invalid_backup",
    );
    const schema = db.prepare("PRAGMA user_version").get().user_version;
    if (supportedSchema) {
      requireValue(
        schema >= 1 && schema <= SCHEMA_VERSION,
        "unsupported_schema",
      );
      for (const table of [
        "meta",
        "rooms",
        "sessions",
        "invites",
        "assets",
        "songs",
        "commands",
        "audit",
      ])
        db.prepare(`SELECT value FROM ${table} LIMIT 1`).get();
    }
    return schema;
  } finally {
    db.close();
  }
}
export function backup(
  directory,
  destination,
  { archiveUnknownSchema = false } = {},
) {
  requireValue(!fs.existsSync(destination), "backup_destination_exists");
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const target = path.join(destination, "encore.sqlite");
  const source = new DatabaseSync(path.join(directory, "encore.sqlite"));
  try {
    source.prepare("VACUUM INTO ?").run(target);
  } finally {
    source.close();
  }
  fs.chmodSync(target, 0o600);
  const schema = validate(target, { supportedSchema: !archiveUnknownSchema });
  sync(target);
  const metadata = {
    schema,
    application: "1.14.0",
    createdAt: new Date().toISOString(),
    sha256: checksum(target),
    settings: "included in SQLite",
    credentials: "excluded: preserve deployment secrets separately",
  };
  fs.writeFileSync(
    path.join(destination, "backup.json"),
    JSON.stringify(metadata, null, 2),
    { mode: 0o600 },
  );
  sync(path.join(destination, "backup.json"));
  sync(destination);
  return metadata;
}
export function restore(directory, source) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const unlock = lock(directory);
  const target = path.join(directory, "encore.sqlite");
  const temporary = path.join(directory, `restore-${secret()}.sqlite`);
  try {
    const metadata = JSON.parse(
      fs.readFileSync(path.join(source, "backup.json"), "utf8"),
    );
    const snapshot = path.join(source, "encore.sqlite");
    requireValue(
      metadata.schema >= 1 &&
        metadata.schema <= SCHEMA_VERSION &&
        metadata.sha256 === checksum(snapshot),
      "backup_checksum_mismatch",
    );
    validate(snapshot);
    // An interrupted/newer upgrade may have a schema this binary cannot run. Preserve it
    // for diagnosis without requiring it to match the older snapshot being restored.
    if (fs.existsSync(target))
      backup(
        directory,
        path.join(
          directory,
          `before-restore-${Date.now()}-${secret().slice(0, 8)}`,
        ),
        { archiveUnknownSchema: true },
      );
    fs.copyFileSync(snapshot, temporary);
    fs.chmodSync(temporary, 0o600);
    const db = new DatabaseSync(temporary);
    try {
      db.exec("PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE;");
      db.prepare(
        "INSERT OR REPLACE INTO meta(key,value) VALUES('authEpoch',?)",
      ).run(JSON.stringify(secret()));
      db.prepare(
        "INSERT OR REPLACE INTO meta(key,value) VALUES('restoredAt',?)",
      ).run(JSON.stringify(new Date().toISOString()));
      db.exec(
        "DELETE FROM sessions; DELETE FROM invites; DELETE FROM commands; DELETE FROM attempts;",
      );
      for (const row of db.prepare("SELECT id,value FROM rooms").all()) {
        const room = JSON.parse(row.value);
        room.members = {};
        room.desired = "paused";
        room.observed = "unavailable";
        room.recoveryRequired = true;
        room.revision++;
        if (room.lease) room.lease.releaseRequested = true;
        db.prepare("UPDATE rooms SET value=? WHERE id=?").run(
          JSON.stringify(room),
          row.id,
        );
      }
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    validate(temporary);
    sync(temporary);
    // Checkpoint the old database before replacing it, so its WAL cannot be applied to the restore.
    if (fs.existsSync(target)) {
      const old = new DatabaseSync(target);
      try {
        old.exec(
          "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;",
        );
      } finally {
        old.close();
      }
    }
    fs.renameSync(temporary, target);
    sync(directory);
    return {
      restored: true,
      authenticationInvalidated: true,
      physicalRecoveryRequired: true,
    };
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    unlock();
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [action, destination] = process.argv.slice(2);
  requireValue(
    ["backup", "restore"].includes(action) && destination,
    "usage: node server/operations.mjs backup|restore DIRECTORY",
  );
  const result =
    action === "backup"
      ? backup(
          path.resolve(process.env.DATA_DIR || "data"),
          path.resolve(destination),
        )
      : restore(
          path.resolve(process.env.DATA_DIR || "data"),
          path.resolve(destination),
        );
  console.log(JSON.stringify(result, null, 2));
}

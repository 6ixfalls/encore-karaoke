import path from "node:path";
import { SCHEMA_VERSION, requireValue } from "../shared/contracts.js";
import { backup } from "./operations.mjs";
import { secret } from "./secrets.mjs";

export const MIGRATIONS = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE sessions (id TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE rooms (id TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE invites (id TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE songs (id TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE assets (id TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE commands (id TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE attempts (id INTEGER PRIMARY KEY, device TEXT, room TEXT, time INTEGER);
   CREATE INDEX attempts_room_time ON attempts(room, time);
   CREATE INDEX attempts_device_time ON attempts(device, time);
   CREATE TABLE audit (id INTEGER PRIMARY KEY, value TEXT NOT NULL);`,
  `CREATE INDEX commands_expiry ON commands(json_extract(value,'$.expires'));
   CREATE INDEX sessions_expiry ON sessions(json_extract(value,'$.expires'));
   CREATE INDEX invites_expiry ON invites(json_extract(value,'$.expires'));
   CREATE INDEX songs_title ON songs(json_extract(value,'$.title'),id);`,
];

export function migrate(db, directory, migrations = MIGRATIONS) {
  const version = db.prepare("PRAGMA user_version").get().user_version;
  requireValue(version <= SCHEMA_VERSION, "unsupported_schema", 503);
  if (version === SCHEMA_VERSION) return;
  if (version > 0)
    backup(
      directory,
      path.join(
        directory,
        "backups",
        `before-schema-${version}-to-${SCHEMA_VERSION}-${Date.now()}-${secret().slice(0, 8)}`,
      ),
    );
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let current = version; current < SCHEMA_VERSION; current++) {
      requireValue(
        typeof migrations[current] === "string",
        "missing_migration",
        503,
      );
      db.exec(migrations[current]);
      db.exec(`PRAGMA user_version=${current + 1}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { requireValue } from "../shared/contracts.js";
import { secret } from "./secrets.mjs";
import { migrate } from "./schema.mjs";

export { secret, digest } from "./secrets.mjs";

export class Store {
  constructor(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, "encore.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    try {
      migrate(this.db, directory);
    } catch (error) {
      this.db.close();
      throw error;
    }
    if (!this.get("meta", "authEpoch")) this.put("meta", "authEpoch", secret());
    this.authEpoch = this.get("meta", "authEpoch");
    // Every process has a new deployment epoch. Authentication survives normal restarts.
    this.deployment = secret();
    this.put("meta", "deployment", this.deployment);
    this.transaction(() => {
      for (const room of this.all("rooms")) {
        room.desired = "paused";
        room.observed = "unavailable";
        if (room.lease && !room.lease.retired)
          room.lease.releaseRequested = true;
        room.revision++;
        this.put("rooms", room.id, room);
      }
    });
  }
  get(table, id) {
    const row = this.db
      .prepare(
        `SELECT value FROM ${this.table(table)} WHERE ${table === "meta" ? "key" : "id"}=?`,
      )
      .get(id);
    return row ? JSON.parse(row.value) : undefined;
  }
  put(table, id, value) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO ${this.table(table)} (${table === "meta" ? "key" : "id"},value) VALUES (?,?)`,
      )
      .run(id, JSON.stringify(value));
  }
  all(table) {
    return this.db
      .prepare(`SELECT value FROM ${this.table(table)}`)
      .all()
      .map((r) => JSON.parse(r.value));
  }
  delete(table, id) {
    this.db.prepare(`DELETE FROM ${this.table(table)} WHERE id=?`).run(id);
  }
  table(name) {
    requireValue(
      [
        "meta",
        "sessions",
        "rooms",
        "invites",
        "songs",
        "assets",
        "commands",
        "audit",
      ].includes(name),
    );
    return name;
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}

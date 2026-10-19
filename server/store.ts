import type { Tables } from "./types.js";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { requireValue } from "../shared/contracts.js";
import { secret } from "./secrets.js";
import { migrate } from "./schema.js";

export { secret, digest } from "./secrets.js";

export class Store {
  db: DatabaseSync;
  authEpoch: string;
  deployment: string;
  constructor(directory: string) {
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
    this.authEpoch = this.get("meta", "authEpoch") as string;
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
  get<T extends keyof Tables>(table: T, id: string): Tables[T] | undefined {
    const row = this.db
      .prepare(
        `SELECT value FROM ${this.table(table)} WHERE ${table === "meta" ? "key" : "id"}=?`,
      )
      .get(id);
    return row ? JSON.parse(row.value as string) : undefined;
  }
  put<T extends keyof Tables>(table: T, id: string, value: Tables[T]) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO ${this.table(table)} (${table === "meta" ? "key" : "id"},value) VALUES (?,?)`,
      )
      .run(id, JSON.stringify(value));
  }
  all<T extends keyof Tables>(table: T): Tables[T][] {
    return this.db
      .prepare(`SELECT value FROM ${this.table(table)}`)
      .all()
      .map((r) => JSON.parse(r.value as string));
  }
  delete(table: keyof Tables, id: string) {
    this.db.prepare(`DELETE FROM ${this.table(table)} WHERE id=?`).run(id);
  }
  table(name: keyof Tables) {
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
  transaction<T>(fn: () => T): T {
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

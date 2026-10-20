import type { Tables } from "./types.js";
export { secret, digest } from "./secrets.js";

type Change = { table: keyof Tables; id: string; previous: unknown; existed: boolean };

/** Process-local room state. Nothing is read from or written to disk. */
export class Store {
  private tables = new Map<keyof Tables, Map<string, unknown>>();
  private journal: Change[] | null = null;
  attempts: { device: string; room: string; time: number }[] = [];
  get<T extends keyof Tables>(table: T, id: string): Tables[T] | undefined {
    const value = this.tables.get(table)?.get(id);
    return value === undefined ? undefined : structuredClone(value) as Tables[T];
  }
  private record(table: keyof Tables, id: string) {
    const values = this.tables.get(table);
    this.journal?.push({ table, id, previous: values?.get(id), existed: values?.has(id) ?? false });
  }
  put<T extends keyof Tables>(table: T, id: string, value: Tables[T]) {
    this.record(table, id);
    if (!this.tables.has(table)) this.tables.set(table, new Map());
    this.tables.get(table)!.set(id, structuredClone(value));
  }
  all<T extends keyof Tables>(table: T): Tables[T][] {
    return [...(this.tables.get(table)?.values() || [])].map(value => structuredClone(value) as Tables[T]);
  }
  delete(table: keyof Tables, id: string) {
    this.record(table, id);
    this.tables.get(table)?.delete(id);
  }
  transaction<T>(fn: () => T): T {
    const nested = this.journal !== null;
    this.journal ??= [];
    const checkpoint = this.journal.length, attempts = this.attempts.slice();
    try { return fn(); }
    catch (error) {
      for (let i = this.journal.length - 1; i >= checkpoint; i--) {
        const { table, id, previous, existed } = this.journal[i];
        if (existed) this.tables.get(table)!.set(id, previous);
        else this.tables.get(table)?.delete(id);
      }
      this.journal.length = checkpoint;
      this.attempts = attempts;
      throw error;
    } finally { if (!nested) this.journal = null; }
  }
  sweep(now: number) {
    for (const table of ["sessions", "commands", "invites"] as const)
      for (const [id, value] of this.tables.get(table) || [])
        if ((value as { expires: number }).expires < now) this.delete(table, id);
    this.attempts = this.attempts.filter(a => a.time > now - 10_000);
  }
  close() { this.tables.clear(); this.attempts = []; }
}

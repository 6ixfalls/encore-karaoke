import type { Store } from "./store.js";
import type { Configuration } from "./config.js";
import type { Session, Role } from "./types.js";
import type { Request } from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { secret, digest } from "./store.js";
import { requireValue, text, Fault } from "../shared/contracts.js";

export class Auth {
  attempts: Map<string, number[]>;
  constructor(private store: Store, private config: Configuration) {
    this.attempts = new Map();
  }
  session(cookie = ""): Session | null {
    const token = cookie
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("encore_session="))
      ?.slice(15);
    const session = token ? this.store.get("sessions", digest(token)) : undefined;
    return session &&
      !session.revoked &&
      session.epoch === this.store.authEpoch &&
      session.expires > Date.now()
      ? session
      : null;
  }
  create(role: Role, nickname: unknown, principal?: string) {
    const token = secret();
    const session: Session = {
      id: randomUUID(),
      role,
      nickname: text(nickname, 40),
      csrf: secret(),
      epoch: this.store.authEpoch,
      principal:
        principal ||
        (["admin", "host"].includes(role)
          ? digest(
              `${role}:${role === "admin" ? this.config.adminKey : this.config.hostKey || this.config.adminKey}`,
            )
          : undefined),
      expires: Date.now() + 7 * 86_400_000,
      tokenHash: digest(token),
      revoked: false,
    };
    this.store.put("sessions", session.tokenHash, session);
    return {
      session,
      cookie: `encore_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${this.config.secure ? "; Secure" : ""}`,
    };
  }
  login(key: unknown): "admin" | "host" {
    requireValue(
      typeof key === "string" && key.length <= 512,
      "invalid_credentials",
      401,
    );
    const equal = (expected: string | undefined) =>
      expected &&
      timingSafeEqual(Buffer.from(digest(key)), Buffer.from(digest(expected)));
    if (equal(this.config.adminKey)) return "admin";
    if (equal(this.config.hostKey)) return "host";
    throw new Fault("invalid_credentials", 401);
  }
  origin(origin: unknown) {
    requireValue(origin === this.config.origin, "invalid_origin", 403);
  }
  mutation(req: Request) {
    this.origin(req.headers.origin);
    if (req.session)
      requireValue(
        req.headers["x-csrf-token"] === req.session.csrf,
        "invalid_csrf",
        403,
      );
  }
  throttle(key: string, limit = 10) {
    const now = Date.now();
    for (const [k, times] of this.attempts)
      if (times.at(-1)! <= now - 60_000) this.attempts.delete(k);
    requireValue(
      this.attempts.size < 10_000 || this.attempts.has(key),
      "rate_limited",
      429,
    );
    const times = (this.attempts.get(key) || []).filter(
      (t) => t > now - 60_000,
    );
    if (times.length >= limit)
      throw new Fault("rate_limited", 429, 60_000 - (now - times[0]));
    times.push(now);
    this.attempts.set(key, times);
  }
}

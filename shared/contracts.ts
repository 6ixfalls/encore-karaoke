export const PROTOCOL_VERSION = 1;
export const LIMITS = Object.freeze({
  room: 100,
  guest: 5,
  deviceRate: 5,
  roomRate: 20,
  windowMs: 10_000,
  leaseMs: 10_000,
  commandDeviceRate: 20,
  commandGlobalRate: 100,
  rejectedCommandMs: 60_000,
});
export const COMMANDS = new Set([
  "enqueue",
  "cheer",
  "remove",
  "reorder",
  "play",
  "pause",
  "skip",
  "seek",
  "volume",
  "tempo",
  "lock",
  "end",
  "policy",
  "revoke",
]);

export class Fault extends Error {
  code: string;
  status: number;
  retryAfterMs?: number;
  constructor(code: string, status = 400, retryAfterMs?: number) {
    super(code);
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}
export function requireValue(
  condition: unknown,
  code = "invalid_request",
  status = 400,
): asserts condition {
  if (!condition) throw new Fault(code, status);
}
export function text(value: unknown, max = 80) {
  requireValue(
    typeof value === "string" && value.trim().length > 0 && value.length <= max,
  );
  return value.trim();
}
export function number(value: unknown, min: number, max: number) {
  requireValue(typeof value === "number" && Number.isFinite(value) && value >= min && value <= max);
  return value;
}

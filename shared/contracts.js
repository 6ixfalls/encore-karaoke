export const PROTOCOL_VERSION = 1;
export const SCHEMA_VERSION = 2;
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
  constructor(code, status = 400, retryAfterMs) {
    super(code);
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}
export function requireValue(
  condition,
  code = "invalid_request",
  status = 400,
) {
  if (!condition) throw new Fault(code, status);
}
export function text(value, max = 80) {
  requireValue(
    typeof value === "string" && value.trim().length > 0 && value.length <= max,
  );
  return value.trim();
}
export function number(value, min, max) {
  requireValue(Number.isFinite(value) && value >= min && value <= max);
  return value;
}

/** Ephemeral room records. Incoming payloads still require runtime validation. */
export type Role = "host" | "guest";
export interface Session {
  id: string;
  role: Role;
  nickname: string;
  roomId?: string;
  expires: number;
  tokenHash: string;
  revoked: boolean;
}
export interface Reservation {
  id: string;
  songId: string;
  title: string;
  artist: string;
  owner: string;
  nickname: string;
}
export interface Playback extends Reservation {
  reservationId: string;
  playbackId: string;
  confirmed: boolean;
  seek?: { position: number; id: string };
}
export interface Lease {
  deviceId: string;
  generation: string;
  deadline: number;
  releaseRequested: boolean;
  retired: boolean;
}
export type PlaybackState = "idle" | "unavailable" | "loading" | "ready" | "playing" | "paused" | "buffering" | "failed" | "ended";
export interface Room {
  id: string;
  name: string;
  screenId: string;
  expires?: number;
  pairing?: { code: string; token: string };
  status: "open" | "locked" | "ended";
  revision: number;
  queue: Reservation[];
  current: Playback | null;
  desired: "paused" | "playing";
  observed: PlaybackState;
  volume: number;
  tempo: number;
  position: number;
  sampleTime?: number;
  scores?: { playbackId: string; title: string; nickname: string; value: number; mode: "guide" | "stability" }[];
  members: Record<string, { nickname: string; role: Role }>;
  policy: { roomCap: number; guestCap: number; guestControl: boolean };
  lease: Lease | null;
}
export interface Invitation {
  roomId: string;
  expires: number;
  invitation: string;
  code: string;
}
export interface Song {
  duration?: number;
  metadataExpires?: number;
  id: string;
  title: string;
  artist: string;
  format: "youtube";
  videoId: string;
}
export interface CommandResult {
  commandId: string;
  accepted: boolean;
  revision: number;
  error?: string;
  status?: number;
  retryAfterMs?: number;
}
export interface Command {
  commandId: string;
  type: string;
  expectedRevision?: number;
  payload?: Record<string, unknown>;
}
export interface Telemetry {
  leaseGeneration: string;
  playbackId: string;
  state: PlaybackState;
  position: number;
  score?: { value: number; samples: number; mode: "guide" | "stability" };
}
export interface Tables {
  sessions: Session;
  rooms: Room;
  invites: Invitation;
  songs: Song;
  commands: { fingerprint: string; result: CommandResult; expires: number };
}
export interface ServiceError extends Error {
  code?: string;
  errcode?: number;
  type?: string;
  retryAfterMs?: number;
}
export const serviceError = (error: unknown): ServiceError =>
  error instanceof Error ? error : new Error(String(error));

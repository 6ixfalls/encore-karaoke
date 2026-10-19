/** Durable server records. Incoming payloads still require runtime validation. */
export type Role = "admin" | "host" | "guest" | "display";
export interface Session {
  id: string;
  role: Role;
  nickname: string;
  csrf: string;
  epoch: string;
  principal?: string;
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
  epoch: string;
  deadline: number;
  releaseHash: string;
  releaseRequested: boolean;
  retired: boolean;
}
export type PlaybackState = "idle" | "unavailable" | "loading" | "ready" | "playing" | "paused" | "buffering" | "failed" | "ended";
export interface Room {
  id: string;
  name: string;
  ownerPrincipal?: string;
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
  members: Record<string, { nickname: string; role: Role }>;
  policy: { roomCap: number; guestCap: number; guestControl: boolean };
  lease: Lease | null;
  recoveryRequired?: boolean;
}
export interface Invitation {
  roomId: string;
  epoch: string;
  expires: number;
  kind: "guest" | "display";
  invitation: string;
  code: string;
}
export interface Song {
  id: string;
  title: string;
  artist: string;
  assetId: string;
  format: "mp3";
  lyricsId?: string;
}
export interface Asset {
  id: string;
  relative: string;
  size: number;
  mtime: number;
  type: string;
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
}
export interface Retirement {
  generation: string;
  outputsPhysicallyIsolated: boolean;
  browserTerminatedAndPairingCleared: boolean;
  allPossiblyOutstandingDisplaysIsolated?: boolean;
}
export interface Tables {
  meta: unknown;
  sessions: Session;
  rooms: Room;
  invites: Invitation;
  songs: Song;
  assets: Asset;
  commands: { fingerprint: string; result: CommandResult; expires: number };
  audit: unknown;
}
export interface ServiceError extends Error {
  code?: string;
  errcode?: number;
  type?: string;
  retryAfterMs?: number;
}
export const serviceError = (error: unknown): ServiceError =>
  error instanceof Error ? error : new Error(String(error));

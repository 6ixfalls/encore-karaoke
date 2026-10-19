import type { Store } from "./store.js";
import { serviceError } from "./types.js";
import type { Asset, Song } from "./types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { digest } from "./store.js";
import { requireValue } from "../shared/contracts.js";

const TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".flac": "audio/flac",
  ".m4a": "audio/mp4", ".aac": "audio/aac", ".opus": "audio/ogg",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska", ".mov": "video/quicktime",
  ".mid": "audio/midi", ".midi": "audio/midi", ".kar": "audio/midi",
  ".cdg": "application/octet-stream", ".lrc": "text/plain; charset=utf-8",
};
const MIDI = new Set([".mid", ".midi", ".kar"]);
const VIDEO = new Set([".mp4", ".webm", ".mkv", ".mov"]);
export const inside = (root: string, file: string) =>
  file !== root &&
  !path.relative(root, file).startsWith(`..${path.sep}`) &&
  path.relative(root, file) !== ".." &&
  !path.isAbsolute(path.relative(root, file));

export class Library {
  scanning: boolean;
  status: { state: string; count?: number; error?: string };
  constructor(private store: Store, private directory: string) {
    this.scanning = false;
    this.status = { state: "idle" };
  }
  async scan() {
    requireValue(!this.scanning, "scan_in_progress", 409);
    this.scanning = true;
    this.status = { state: "scanning" };
    try {
      const root = await fs.realpath(this.directory);
      const assets: Asset[] = [],
        songs: Song[] = [];
      const walk = async (directory: string, depth = 0) => {
        requireValue(depth <= 24 && songs.length < 100_000, "library_limit");
        const entries = await fs.readdir(directory, { withFileTypes: true });
        const siblings = new Map(entries.filter((e) => e.isFile() && !e.isSymbolicLink()).map((e) => [e.name.toLowerCase(), e.name]));
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const filename = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            await walk(filename, depth + 1);
            continue;
          }
          const extension = path.extname(entry.name).toLowerCase();
          if (
            !entry.isFile() ||
            !TYPES[extension] || [".lrc", ".cdg"].includes(extension)
          )
            continue;
          if (entry.name.toLowerCase().endsWith(".vocals.wav")) {
            const reference = await this.indexAsset(root, filename);
            requireValue(reference.size <= 32 * 1024 * 1024, "reference_too_large");
            assets.push(reference);
            continue;
          }
          const relative = path.relative(root, filename);
          const id = digest(`song:${relative}`);
          const asset = await this.indexAsset(root, filename);
          assets.push(asset);
          const stem = path.basename(entry.name, path.extname(entry.name));
          const separator = stem.indexOf(" - ");
          const song: Song = {
            id,
            title: separator >= 0 ? stem.slice(separator + 3) : stem,
            artist: separator >= 0 ? stem.slice(0, separator) : "",
            assetId: asset.id,
            format: MIDI.has(extension) ? "midi" : VIDEO.has(extension) ? "video" : extension === ".mp3" ? "mp3" : "audio",
          };
          try {
            const lyrics = await this.indexAsset(
              root,
              path.join(directory, siblings.get(`${stem}.lrc`.toLowerCase()) || `${stem}.lrc`),
            );
            requireValue(lyrics.size <= 2 * 1024 * 1024, "lyrics_too_large");
            assets.push(lyrics);
            song.lyricsId = lyrics.id;
          } catch (error) {
            if (serviceError(error).code !== "ENOENT") throw error;
          }
          for (const [suffix, key, limit] of [[".cdg", "cdgId", 32 * 1024 * 1024], [".mid", "guideId", 4 * 1024 * 1024], [".vocals.wav", "referenceId", 32 * 1024 * 1024]] as const) {
            const companion = siblings.get(`${stem}${suffix}`.toLowerCase());
            if (!companion || MIDI.has(extension)) continue;
            const sidecar = await this.indexAsset(root, path.join(directory, companion));
            requireValue(sidecar.size <= limit, "companion_too_large");
            assets.push(sidecar);
            song[key] = sidecar.id;
          }
          if (song.format === "midi") requireValue(asset.size <= 4 * 1024 * 1024, "midi_too_large");
          songs.push(song);
        }
      };
      await walk(root);
      this.store.transaction(() => {
        this.store.db.exec("DELETE FROM songs WHERE json_extract(value,'$.format') IS NOT 'youtube'; DELETE FROM assets;");
        for (const a of assets) this.store.put("assets", a.id, a);
        for (const s of songs) this.store.put("songs", s.id, s);
        this.store.put("meta", "library", {
          count: songs.length,
          scannedAt: Date.now(),
        });
      });
      this.status = { state: "complete", count: songs.length };
      return this.status;
    } catch (error) {
      this.status = { state: "failed", error: serviceError(error).code || "scan_failed" };
      throw error;
    } finally {
      this.scanning = false;
    }
  }
  vocalReference(videoId: string) {
    return this.store.all("assets").find(asset => {
      const name = path.basename(asset.relative);
      return name.slice(0, -11) === videoId && name.slice(-11).toLowerCase() === ".vocals.wav";
    })?.id;
  }
  async indexAsset(root: string, filename: string): Promise<Asset> {
    const canonical = await fs.realpath(filename);
    requireValue(inside(root, canonical), "outside_library", 403);
    const stat = await fs.stat(canonical);
    requireValue(stat.isFile(), "invalid_asset");
    const relative = path.relative(root, canonical);
    return {
      id: digest(`asset:${relative}`),
      relative,
      size: stat.size,
      mtime: stat.mtimeMs,
      type: TYPES[path.extname(canonical).toLowerCase()],
    };
  }
  async open(id: string) {
    const asset = this.store.get("assets", id);
    requireValue(asset, "asset_not_found", 404);
    const root = await fs.realpath(this.directory);
    const filename = await fs.realpath(path.resolve(root, asset.relative));
    requireValue(inside(root, filename), "outside_library", 403);
    // Open the verified target, then check its identity. Library mounts must remain read-only during serving.
    const handle = await fs.open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await handle.stat();
      const verified = await fs.realpath(path.resolve(root, asset.relative));
      requireValue(inside(root, verified), "outside_library", 403);
      const current = await fs.stat(verified);
      requireValue(
        stat.isFile() && stat.dev === current.dev && stat.ino === current.ino,
        "invalid_asset",
        404,
      );
      return { asset, stat, handle };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  search(query: string, offset = 0) {
    const pattern = `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const where =
      "WHERE json_extract(value,'$.format') IS NOT 'youtube' AND (json_extract(value,'$.title') || ' ' || json_extract(value,'$.artist')) LIKE ? ESCAPE '\\'";
    const items = this.store.db
      .prepare(
        `SELECT value FROM songs ${where} ORDER BY json_extract(value,'$.title'),id LIMIT 50 OFFSET ?`,
      )
      .all(pattern, offset)
      .map((r) => JSON.parse(r.value as string) as Song);
    const total = this.store.db
      .prepare(`SELECT count(*) AS total FROM songs ${where}`)
      .get(pattern)!.total;
    return { items, total, offset };
  }
}

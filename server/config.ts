import path from "node:path";
import { requireValue } from "../shared/contracts.js";

export function configuration(env: NodeJS.ProcessEnv = process.env) {
  const publicUrl = new URL(env.PUBLIC_BASE_URL || "http://localhost:3000");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(
    publicUrl.hostname,
  );
  requireValue(
    publicUrl.pathname === "/" &&
      !publicUrl.search &&
      !publicUrl.hash &&
      !publicUrl.username &&
      !publicUrl.password,
  );
  requireValue(
    publicUrl.protocol === "https:" ||
      (local && publicUrl.protocol === "http:"),
    "https_required",
  );
  const separationDevice = env.SEPARATION_DEVICE || "cpu";
  const ffmpegVideoMode = env.FFMPEG_VIDEO_MODE || "copy";
  const ffmpegGpu = env.FFMPEG_GPU || "0";
  requireValue(/^(cpu|mps|cuda(?::\d+)?)$/.test(separationDevice), "invalid_separation_device");
  requireValue(["copy", "nvidia"].includes(ffmpegVideoMode), "invalid_ffmpeg_video_mode");
  requireValue(/^\d+$/.test(ffmpegGpu), "invalid_ffmpeg_gpu");
  return {
    origin: publicUrl.origin,
    secure: publicUrl.protocol === "https:",
    port: Number(env.PORT || 3000),
    host: env.LISTEN_HOST || "0.0.0.0",
    web: path.resolve(env.WEB_DIR || "dist/web"),
    maxTransfers: 16,
    ytDlp: env.YT_DLP_PATH || "yt-dlp",
    ffmpeg: env.FFMPEG_PATH || "ffmpeg",
    python: env.SEPARATION_PYTHON || "python3",
    separationDevice,
    ffmpegVideoMode,
    ffmpegGpu,
    maxSeparations: 1,
    trustedProxies: (env.TRUSTED_PROXIES || "").split(",").map((ip) => ip.trim()).filter(Boolean),
  };
}

export type Configuration = ReturnType<typeof configuration>;

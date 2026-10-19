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
  const invidious = env.INVIDIOUS_URL ? new URL(env.INVIDIOUS_URL) : undefined;
  requireValue(!invidious || (["http:", "https:"].includes(invidious.protocol) &&
    !invidious.username && !invidious.password && invidious.pathname === "/" &&
    !invidious.search && !invidious.hash), "invalid_invidious_url");
  return {
    origin: publicUrl.origin,
    secure: publicUrl.protocol === "https:",
    port: Number(env.PORT || 3000),
    host: env.LISTEN_HOST || "0.0.0.0",
    data: path.resolve(env.DATA_DIR || "data"),
    library: path.resolve(env.LIBRARY_DIR || "library"),
    web: path.resolve(env.WEB_DIR || "dist/web"),
    maxTransfers: 16,
    invidiousUrl: invidious?.origin,
    trustedProxies: (env.TRUSTED_PROXIES || "").split(",").map((ip) => ip.trim()).filter(Boolean),
  };
}

export type Configuration = ReturnType<typeof configuration>;

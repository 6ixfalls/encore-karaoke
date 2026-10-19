import path from "node:path";
import fs from "node:fs";
import { requireValue } from "../shared/contracts.js";

export function configuration(env = process.env) {
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
  const credential = (name, required) => {
    const value = env[`${name}_FILE`]
      ? fs.readFileSync(env[`${name}_FILE`], "utf8").trim()
      : env[name];
    requireValue(
      (!required && !value) ||
        (typeof value === "string" && value.length >= 24),
      `${name.toLowerCase()}_must_have_24_characters`,
    );
    return value;
  };
  return {
    origin: publicUrl.origin,
    secure: publicUrl.protocol === "https:",
    port: Number(env.PORT || 3000),
    host: env.LISTEN_HOST || "0.0.0.0",
    data: path.resolve(env.DATA_DIR || "data"),
    library: path.resolve(env.LIBRARY_DIR || "library"),
    web: path.resolve(env.WEB_DIR || "dist/web"),
    adminKey: credential("ADMIN_KEY", true),
    hostKey: credential("HOST_KEY", false),
    maxTransfers: 16,
    trustedProxies: (env.TRUSTED_PROXIES || "").split(",").map((ip) => ip.trim()).filter(Boolean),
  };
}

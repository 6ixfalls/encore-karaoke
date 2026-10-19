import { randomBytes, createHash } from "node:crypto";

export const secret = () => randomBytes(32).toString("base64url");
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");

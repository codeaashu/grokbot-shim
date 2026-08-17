import crypto from "node:crypto";

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function mintJwt({ sub = "shim-local-user", email = "shim@local", ttlSec = 3600 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { sub, email, iat: now, exp: now + ttlSec };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.randomBytes(32));
  return `${h}.${p}.${sig}`;
}

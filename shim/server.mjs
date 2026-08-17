import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mintJwt } from "./jwt.mjs";
import { decodeStreamRequest, runSession, requestSummary } from "./inference.mjs";
import { encodeAvailableModels } from "./models.mjs";
import { statsigBootstrap } from "./statsig.mjs";

function parseConnectFrames(buf) {
  const frames = [];
  let off = 0;
  while (off + 5 <= buf.length) {
    const flags = buf[off];
    const len = buf.readUInt32BE(off + 1);
    if (off + 5 + len > buf.length) break;
    frames.push({ flags, payload: buf.subarray(off + 5, off + 5 + len) });
    off += 5 + len;
  }
  return frames;
}

function frameBytes(flags, payload) {
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

// Connect streaming requires the trailing frame (flag 0x02) to carry a JSON
// EndStreamResponse. A zero-length payload makes the client throw
// "failed to parse EndStreamResponse: invalid end stream".
const CONNECT_END_FRAME = frameBytes(0x02, Buffer.from("{}", "utf8"));

function envelope(payload) {
  return frameBytes(0x00, payload);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 8443);
const MODE = process.env.MODE ?? "stub"; // stub | forward
const UPSTREAM = process.env.UPSTREAM ?? "https://api2.cursor.sh";
const LOG_DIR = path.join(ROOT, "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });

const stamp = new Date().toISOString().slice(0, 10);
const jsonl = fs.createWriteStream(path.join(LOG_DIR, `capture-${stamp}.jsonl`), { flags: "a" });

const STATE_DIR = path.join(ROOT, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });
const HOST_TOKEN_FILE = path.join(STATE_DIR, "host-token.json");
const HOST_TOKEN_TTL_SEC = 3600;
const HOST_TOKEN_ROTATE_MS = 30 * 60 * 1000;

function writeHostToken(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString("utf8"));
    const nextPath = `${HOST_TOKEN_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(nextPath, JSON.stringify({ accessToken: jwt, expiresAtMs: (payload.exp ?? 0) * 1000 }), {
      mode: 0o600,
    });
    fs.renameSync(nextPath, HOST_TOKEN_FILE);
  } catch (err) {
    console.error("writeHostToken failed:", err?.message ?? err);
  }
}

function rotateHostToken() {
  writeHostToken(mintJwt({ ttlSec: HOST_TOKEN_TTL_SEC }));
}

// The packaged desktop normally refreshes this credential through its auth
// flow. The local host can run without the desktop, so keep its dev token file
// independently fresh instead of waiting for an incidental auth request.
rotateHostToken();
setInterval(rotateHostToken, HOST_TOKEN_ROTATE_MS).unref();

let seq = 0;

function log(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), seq: ++seq, ...entry });
  jsonl.write(line + "\n");
}

function summary(method, p, ct, len, out) {
  console.log(`[${String(seq).padStart(4)}] ${method} ${p} (${ct ?? "?"}, ${len}B) -> ${out}`);
}

function cors(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", "*");
  res.setHeader("access-control-expose-headers", "*");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function tryJson(buf) {
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return undefined;
  }
}

const HOP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
]);

async function forward(req, p, body, res) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }
  const target = UPSTREAM.replace(/\/+$/, "") + p;
  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: body.length > 0 ? body : undefined,
    redirect: "manual",
  });
  const respBuf = Buffer.from(await upstream.arrayBuffer());
  const respHeaders = {};
  upstream.headers.forEach((v, k) => {
    if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k.toLowerCase())) {
      respHeaders[k] = v;
    }
  });
  cors(res);
  res.writeHead(upstream.status, respHeaders);
  res.end(respBuf);
  log({
    kind: "forwarded-response",
    path: p,
    status: upstream.status,
    respContentType: upstream.headers.get("content-type"),
    respBodyB64: respBuf.toString("base64"),
    respBodyText: respBuf.length < 200_000 ? respBuf.toString("utf8") : undefined,
  });
  return `forward ${upstream.status} (${respBuf.length}B)`;
}

function stubResponse(req, p, res) {
  const ct = String(req.headers["content-type"] ?? "");
  cors(res);
  if (ct.includes("application/connect+")) {
    // Connect streaming: just the end-of-stream frame, no messages.
    res.writeHead(200, { "content-type": ct });
    res.end(CONNECT_END_FRAME);
    return "stub empty-stream";
  }
  if (ct.includes("application/proto")) {
    res.writeHead(200, { "content-type": "application/proto" });
    res.end(Buffer.alloc(0));
    return "stub empty-proto";
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
  return "stub {}";
}

const server = https.createServer(
  {
    key: fs.readFileSync(path.join(ROOT, "certs", "localhost.key")),
    cert: fs.readFileSync(path.join(ROOT, "certs", "localhost.pem")),
  },
  async (req, res) => {
    const p = req.url ?? "/";
    const pathname = p.split("?")[0];
    const body = await readBody(req);
    const ct = String(req.headers["content-type"] ?? "");
    const bodyJson = tryJson(body);

    log({
      kind: "request",
      method: req.method,
      path: p,
      headers: req.headers,
      bodyB64: body.toString("base64"),
      bodyJson,
    });

    if (req.method === "OPTIONS") {
      cors(res);
      res.writeHead(204);
      res.end();
      summary(req.method, p, ct, body.length, "cors 204");
      return;
    }

    let out;
    try {
      if (pathname === "/auth/cursor_dev_session_token") {
        const accessToken = mintJwt();
        const refreshToken = mintJwt({ ttlSec: 86400 * 30 });
        writeHostToken(accessToken);
        cors(res);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ accessToken, refreshToken, authId: "shim-local-user" }));
        out = "dev-session-token";
      } else if (pathname === "/oauth/token") {
        const accessToken = mintJwt();
        writeHostToken(accessToken);
        cors(res);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: accessToken,
            refresh_token: mintJwt({ ttlSec: 86400 * 30 }),
          }),
        );
        out = "oauth-refresh";
      } else if (pathname === "/health") {
        cors(res);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        out = "health";
      } else if (pathname === "/aiserver.v1.AnalyticsService/BootstrapStatsig") {
        const payload = statsigBootstrap();
        cors(res);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
        out = "statsig local bootstrap";
      } else if (pathname === "/aiserver.v1.AiService/AvailableModels") {
        const payload = encodeAvailableModels();
        cors(res);
        res.writeHead(200, { "content-type": "application/proto" });
        res.end(payload);
        out = `available-models ${payload.length}B`;
      } else if (pathname === "/aiserver.v1.InferenceService/Stream") {
        cors(res);
        const msgFrames = parseConnectFrames(body).filter((f) => f.flags === 0);
        if (msgFrames.length === 0) {
          res.writeHead(200, { "content-type": ct });
          res.end(CONNECT_END_FRAME);
          out = "inference: no request frame";
        } else {
          const reqMsg = decodeStreamRequest(msgFrames[0].payload);
          const summary = requestSummary(reqMsg);
          console.log(`[inference] ${summary}`);
          log({ kind: "inference-request", summary });
          res.writeHead(200, { "content-type": ct, "cache-control": "no-store" });
          let n = 0;
          try {
            for await (const frameBytes of runSession(reqMsg)) {
              res.write(envelope(frameBytes));
              n++;
            }
          } catch (err) {
            log({ kind: "inference-error", error: String(err?.stack ?? err) });
            console.error(`[inference] error: ${err?.message ?? err}`);
          }
          res.end(CONNECT_END_FRAME);
          out = `inference ${n} frames`;
        }
      } else if (MODE === "forward") {
        out = await forward(req, p, body, res);
      } else {
        out = stubResponse(req, p, res);
      }
    } catch (err) {
      log({ kind: "error", path: p, error: String(err?.stack ?? err) });
      if (!res.headersSent) {
        cors(res);
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err?.message ?? err) }));
      } else {
        res.end();
      }
      out = `error ${err?.message}`;
    }
    summary(req.method, p, ct, body.length, out);
  },
);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`grokbot-shim recon server: https://localhost:${PORT} (mode=${MODE})`);
  console.log(`capture log: ${path.join(LOG_DIR, `capture-${stamp}.jsonl`)}`);
  if (MODE === "forward") console.log(`upstream: ${UPSTREAM}`);
});

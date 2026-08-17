// Codex OAuth provider: routes inference at the ChatGPT subscription backend
// (https://chatgpt.com/backend-api/codex/responses) using the credentials
// `codex login` already wrote to ~/.codex/auth.json. No API key involved.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { frames, resolveEntry } from "./inference.mjs";
import { structToJson, valueToJson } from "./struct.mjs";

const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_TOKEN_URL = process.env.CODEX_OAUTH_TOKEN_URL ?? "https://auth.openai.com/oauth/token";
const BASE_URL = (process.env.CODEX_BASE_URL ?? "https://chatgpt.com/backend-api/codex").replace(/\/+$/, "");
const REQUEST_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS ?? 600_000);
const REFRESH_SKEW_SEC = Number(process.env.CODEX_REFRESH_SKEW_SECONDS ?? 120);

// Sand's InferenceStreamErrorType.
const ERR = { unknown: 1, inputTokenLimit: 2, rateLimit: 4, auth: 5, permission: 6, overloaded: 7 };

function authFile() {
  if (process.env.CODEX_AUTH_FILE) return path.resolve(process.env.CODEX_AUTH_FILE);
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  return path.join(path.resolve(home), "auth.json");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function writeJsonPrivate(file, payload) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

function jwtPayload(token) {
  if (typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

function tokenIsExpiring(token) {
  const exp = jwtPayload(token)?.exp;
  if (typeof exp !== "number") return false;
  return exp <= Math.floor(Date.now() / 1000) + REFRESH_SKEW_SEC;
}

function accountIdFromToken(token) {
  const id = jwtPayload(token)?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  return typeof id === "string" ? id : undefined;
}

async function refreshTokens(refreshToken) {
  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await resp.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  if (!resp.ok || typeof payload.access_token !== "string") {
    const message = payload?.error_description ?? payload?.error ?? text ?? `HTTP ${resp.status}`;
    throw new Error(`token refresh failed: ${String(message).slice(0, 300)}`);
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || refreshToken,
    idToken: payload.id_token,
  };
}

// Reads (and, when stale, refreshes in place) the credential `codex login` wrote.
export async function resolveCredential() {
  const fromEnv = process.env.CODEX_ACCESS_TOKEN?.trim();
  if (fromEnv) return { accessToken: fromEnv, source: "CODEX_ACCESS_TOKEN" };

  const file = authFile();
  const payload = readJson(file);
  const accessToken = payload?.tokens?.access_token?.trim();
  const refreshToken = payload?.tokens?.refresh_token?.trim();
  if (!accessToken) {
    throw new Error(`no Codex credential in ${file} — run \`codex login\``);
  }
  if (!tokenIsExpiring(accessToken)) return { accessToken, source: file };
  if (!refreshToken) return { accessToken, source: `${file} (expiring, no refresh_token)` };

  const refreshed = await refreshTokens(refreshToken);
  try {
    writeJsonPrivate(file, {
      ...payload,
      tokens: {
        ...payload.tokens,
        access_token: refreshed.accessToken,
        refresh_token: refreshed.refreshToken,
        ...(refreshed.idToken ? { id_token: refreshed.idToken } : {}),
        last_refresh: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error(`[codex] token refreshed but could not write ${file}: ${err?.message ?? err}`);
  }
  return { accessToken: refreshed.accessToken, source: `${file} (refreshed)` };
}

function textOf(message) {
  if (message.content === "text") return message.text ?? "";
  if (message.content === "parts") {
    return (message.parts?.parts ?? [])
      .map((p) => (p.part === "text" ? p.text?.text ?? "" : ""))
      .join("");
  }
  return "";
}

function userParts(message) {
  if (message.content === "text") {
    return message.text ? [{ type: "input_text", text: message.text }] : [];
  }
  const out = [];
  for (const part of message.parts?.parts ?? []) {
    if (part.part === "text" && part.text?.text) {
      out.push({ type: "input_text", text: part.text.text });
    } else if (part.part === "image" && part.image?.data) {
      const data = part.image.data;
      out.push({
        type: "input_image",
        image_url: /^(https?|data):/.test(data)
          ? data
          : `data:${part.image.mimeType || "image/png"};base64,${data}`,
      });
    }
  }
  return out;
}

function imageContentItem(part) {
  if (part?.part !== "image" || !part.image?.data) return undefined;
  const data = part.image.data;
  return {
    type: "input_image",
    image_url: /^(https?|data):/.test(data)
      ? data
      : `data:${part.image.mimeType || "image/png"};base64,${data}`,
    detail: "high",
  };
}

function toolResultOutput(part) {
  const value = valueToJson(part.result);
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  const outputText = part.isError ? `ERROR: ${text}` : text;
  const rich = [];
  if (outputText) rich.push({ type: "input_text", text: outputText });
  for (const contentPart of part.experimentalContent ?? []) {
    const image = imageContentItem(contentPart);
    if (image) rich.push(image);
  }
  // Responses accepts either a plain string or multimodal content items for a
  // function_call_output. Computer screenshots arrive in experimentalContent;
  // keeping them attached to the tool result is what lets the model actually
  // see the desktop it just controlled.
  return rich.some((item) => item.type === "input_image") ? rich : outputText;
}

// Sand keeps reasoning in `reasoning_parts`; we stash the Codex item id +
// encrypted_content in `signature` so the model's own chain of thought survives
// the round trip (required when store=false).
function reasoningItemFrom(part) {
  if (!part?.signature) return undefined;
  try {
    const stashed = JSON.parse(part.signature);
    if (stashed?.__codex !== 1 || !stashed.encrypted_content) return undefined;
    return {
      type: "reasoning",
      id: stashed.id,
      encrypted_content: stashed.encrypted_content,
      summary: part.text ? [{ type: "summary_text", text: part.text }] : [],
    };
  } catch {
    return undefined;
  }
}

function buildRequestBody(req, entry, { withReasoningHistory }) {
  const instructions = [];
  const input = [];

  for (const m of req.messages ?? []) {
    if (m.role === 4 || m.role === 0) {
      const text = textOf(m);
      if (text) instructions.push(text);
      continue;
    }
    if (m.role === 3) {
      for (const part of m.toolContent?.parts ?? []) {
        if (!part.toolCallId) continue;
        input.push({
          type: "function_call_output",
          call_id: part.toolCallId,
          output: toolResultOutput(part),
        });
      }
      continue;
    }
    if (m.role === 2) {
      if (withReasoningHistory) {
        for (const part of m.reasoningParts ?? []) {
          const item = reasoningItemFrom(part);
          if (item) input.push(item);
        }
      }
      const text = textOf(m);
      if (text) input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      for (const call of m.toolCalls ?? []) {
        if (!call.toolCallId || !call.toolName) continue;
        input.push({
          type: "function_call",
          call_id: call.toolCallId,
          name: call.toolName,
          arguments: call.rawToolCallArgs || JSON.stringify(structToJson(call.args) ?? {}),
        });
      }
      continue;
    }
    const parts = userParts(m);
    if (parts.length) input.push({ role: "user", content: parts });
  }

  if (!input.length) input.push({ role: "user", content: [{ type: "input_text", text: "" }] });

  const tools = (req.tools ?? [])
    .filter((t) => t.name)
    .map((t) => ({
      type: "function",
      name: t.name,
      description: t.description ?? "",
      strict: false,
      parameters: structToJson(t.parameters) ?? { type: "object", properties: {} },
    }));

  const body = {
    model: entry.model ?? "gpt-5.6-sol",
    instructions: instructions.join("\n\n") || "You are a helpful assistant.",
    input,
    stream: true,
    store: false,
    prompt_cache_key: req.conversationId || undefined,
  };

  if (tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
    body.parallel_tool_calls = true;
  }

  const effort = (entry.reasoning_effort ?? process.env.CODEX_REASONING_EFFORT ?? "medium").trim();
  if (effort && effort !== "none") {
    body.reasoning = { effort: effort === "minimal" ? "low" : effort, summary: "auto" };
    body.include = ["reasoning.encrypted_content"];
  }

  return body;
}

const sessionIds = new Map();

function sessionIdFor(req) {
  const key = req.conversationId || "default";
  if (!sessionIds.has(key)) sessionIds.set(key, crypto.randomUUID());
  return sessionIds.get(key);
}

async function* sseFrames(webStream) {
  const reader = webStream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            yield JSON.parse(data);
          } catch {
            /* keep-alive or partial frame */
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function errorTypeFor(status, message) {
  if (status === 401 || status === 403) return ERR.auth;
  if (status === 429) return ERR.rateLimit;
  if (status === 500 || status === 502 || status === 503) return ERR.overloaded;
  if (/context|too long|maximum.*tokens/i.test(message)) return ERR.inputTokenLimit;
  return ERR.unknown;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (!days) parts.push(`${minutes}m`);
  return parts.join(" ");
}

function upstreamMessage(status, text, headers) {
  let message;
  let payload;
  try {
    payload = JSON.parse(text);
    message = String(payload?.error?.message ?? payload?.detail ?? payload?.error ?? text);
  } catch {
    message = text || `HTTP ${status}`;
  }
  // Quota errors carry the reset window; surfacing it beats a bare 429.
  const resetIn = [
    payload?.error?.resets_in_seconds,
    headers?.get?.("x-codex-primary-reset-after-seconds"),
  ]
    .map(Number)
    .find(Number.isFinite);
  if (status === 429 && resetIn !== undefined) {
    message += ` (${payload?.error?.plan_type ?? "codex"} plan; resets in ${formatDuration(resetIn)})`;
  }
  return message.slice(0, 600);
}

// Reasoning history is dropped for the rest of the process once the backend
// rejects it (e.g. the desktop dropped a signature between turns).
let reasoningHistoryEnabled = true;

async function postResponses(req, entry, accessToken) {
  const attempt = async (withReasoningHistory) => {
    const body = buildRequestBody(req, entry, { withReasoningHistory });
    if (process.env.CODEX_DEBUG_REQUEST_FILE) {
      fs.writeFileSync(process.env.CODEX_DEBUG_REQUEST_FILE, JSON.stringify(body, null, 2));
    }
    const resp = await fetch(`${BASE_URL}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "text/event-stream",
        "content-type": "application/json",
        "user-agent": "codex_cli_rs/0.0.0 (grokbot-shim)",
        originator: "codex_cli_rs",
        session_id: sessionIdFor(req),
        "x-client-request-id": crypto.randomUUID(),
        ...(accountIdFromToken(accessToken)
          ? { "chatgpt-account-id": accountIdFromToken(accessToken) }
          : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { resp, model: body.model };
  };

  let { resp, model } = await attempt(reasoningHistoryEnabled);
  if (resp.status === 400 && reasoningHistoryEnabled) {
    const text = await resp.text();
    if (/reasoning/i.test(text)) {
      console.warn("[codex] backend rejected reasoning history; retrying without it");
      reasoningHistoryEnabled = false;
      ({ resp, model } = await attempt(false));
    } else {
      return { resp, model, errorText: text };
    }
  }
  return { resp, model };
}

export async function* codexSession(req, entry) {
  let credential;
  try {
    credential = await resolveCredential();
  } catch (err) {
    yield frames.error(`shim: ${err?.message ?? err}`, ERR.auth);
    return;
  }

  let resp;
  let model;
  let errorText;
  try {
    ({ resp, model, errorText } = await postResponses(req, entry, credential.accessToken));
  } catch (err) {
    yield frames.error(`shim: Codex request failed: ${err?.message ?? err}`, ERR.unknown);
    return;
  }

  if (!resp.ok || !resp.body) {
    const text = errorText ?? (await resp.text().catch(() => ""));
    const message = upstreamMessage(resp.status, text, resp.headers);
    // Subscription quota is a hard wall for hours or days; keep the app usable
    // if models.json names a fallback entry.
    const fallback = entry.fallback ? resolveEntry(entry.fallback) : undefined;
    if (fallback && (resp.status === 429 || resp.status === 401 || resp.status === 403)) {
      console.warn(`[codex] ${resp.status}: ${message} — falling back to ${entry.fallback}`);
      const { runEntry } = await import("./inference.mjs");
      yield* runEntry(req, fallback);
      return;
    }
    yield frames.error(`shim: Codex ${resp.status}: ${message}`, errorTypeFor(resp.status, message));
    return;
  }

  let fullText = "";
  let usage;
  const toolCalls = [];
  const reasoningParts = [];

  for await (const event of sseFrames(resp.body)) {
    const type = event.type;

    if (type === "response.output_text.delta") {
      if (typeof event.delta === "string" && event.delta) {
        fullText += event.delta;
        yield frames.text(event.delta);
      }
      continue;
    }

    if (type === "response.reasoning_summary_text.delta") {
      if (typeof event.delta === "string" && event.delta) yield frames.thinking(event.delta);
      continue;
    }

    if (type === "response.reasoning_summary_part.done" || type === "response.reasoning_summary_text.done") {
      yield frames.thinking("", true);
      continue;
    }

    if (type === "response.output_item.done") {
      const item = event.item;
      if (item?.type === "function_call" && item.name) {
        const id = item.call_id || item.id || `codex-tc-${toolCalls.length}`;
        const args = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {});
        toolCalls.push({ id, name: item.name, args });
        yield frames.toolCall({
          toolCallId: id,
          toolName: item.name,
          args,
          isComplete: true,
          toolIndex: toolCalls.length - 1,
        });
      } else if (item?.type === "reasoning") {
        const summary = (item.summary ?? []).map((s) => s?.text ?? "").join("");
        reasoningParts.push({
          text: summary,
          signature: item.encrypted_content
            ? JSON.stringify({ __codex: 1, id: item.id, encrypted_content: item.encrypted_content })
            : "",
          modelName: model,
        });
      }
      continue;
    }

    if (type === "response.completed" || type === "response.incomplete") {
      usage = event.response?.usage ?? usage;
      break;
    }

    if (type === "response.failed" || type === "error") {
      const message = upstreamMessage(200, JSON.stringify(event.response?.error ?? event.error ?? event));
      yield frames.error(`shim: Codex stream failed: ${message}`, errorTypeFor(200, message));
      return;
    }
  }

  yield frames.text("", true);
  yield frames.usage(
    Math.max(1, usage?.input_tokens ?? 0),
    Math.max(1, usage?.output_tokens ?? Math.ceil(fullText.length / 4)),
  );
  yield frames.responseInfo(model, undefined, { content: fullText, toolCalls, reasoningParts });
}

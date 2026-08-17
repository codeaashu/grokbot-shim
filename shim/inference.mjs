import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";

import { structToJson } from "./struct.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const root = protobuf.loadSync(path.join(ROOT, "shim", "inference.proto"));
const StreamRequest = root.lookupType("aiserver.v1.InferenceStreamRequest");
const StreamResponse = root.lookupType("aiserver.v1.InferenceStreamResponse");

export function decodeStreamRequest(buf) {
  return StreamRequest.decode(buf);
}

function frame(oneofField, payload) {
  return StreamResponse.encode(StreamResponse.create({ [oneofField]: payload })).finish();
}

export const frames = {
  text: (text, isFinal = false) => frame("textPart", { text, isFinal }),
  thinking: (text, isFinal = false) => frame("thinkingPart", { text, isFinal }),
  toolCall: (p) => frame("toolCallPart", p),
  usage: (promptTokens, completionTokens) =>
    frame("usage", { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }),
  responseInfo: (model, id, { content = "", toolCalls = [], reasoningParts = [] } = {}) =>
    frame("responseInfo", {
      id: id ?? `shim-${Date.now()}`,
      model,
      createdAt: Date.now(),
      messages: [
        {
          id: `shim-msg-${Date.now()}`,
          role: 2,
          content,
          toolCalls: toolCalls.map((tc) => ({
            toolCallId: tc.id,
            toolName: tc.name,
            rawToolCallArgs: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? {}),
          })),
          reasoningParts,
        },
      ],
    }),
  error: (message, errorType = 1) => frame("error", { message, errorType }),
};

function lastUserText(req) {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m.role !== 1) continue;
    if (m.content === "text") return m.text ?? "";
    if (m.content === "parts") {
      return (m.parts.parts ?? [])
        .map((p) => (p.part === "text" ? p.text?.text ?? "" : ""))
        .join("");
    }
  }
  return "";
}

export function requestSummary(req) {
  const modelId = req.modelId || req.requestedModel?.modelId || "?";
  const user = lastUserText(req).slice(0, 120).replace(/\n/g, " ");
  return `model=${modelId} tools=${req.tools.length} msgs=${req.messages.length} user="${user}"`;
}

function loadModelsConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "models.json"), "utf8"));
  } catch {
    return { default: "canned", models: { canned: { provider: "canned" } } };
  }
}

export function resolveModel(req) {
  const cfg = loadModelsConfig();
  const wanted = req.modelId || req.requestedModel?.modelId || cfg.default;
  const entry = cfg.models[wanted] ?? cfg.models[cfg.default];
  return { wanted, entry: entry ?? { provider: "canned" } };
}

export function resolveEntry(id) {
  return loadModelsConfig().models[id];
}

async function* cannedSession(req) {
  const user = lastUserText(req);
  const reply = `Hello from grokbot-shim! You said: "${user.slice(0, 200)}". Model routing is working — swap me out in models.json.`;
  const words = reply.split(" ");
  for (let i = 0; i < words.length; i++) {
    yield frames.text((i === 0 ? "" : " ") + words[i]);
    await new Promise((r) => setTimeout(r, 25));
  }
  yield frames.text("", true);
  yield frames.usage(Math.max(1, Math.floor(user.length / 4)), Math.max(1, Math.floor(reply.length / 4)));
  const { wanted } = resolveModel(req);
  yield frames.responseInfo(wanted, undefined, { content: reply });
}

function sseLines(chunkText, leftover) {
  const text = leftover + chunkText;
  const lines = text.split("\n");
  return { lines: lines.slice(0, -1), leftover: lines.at(-1) };
}

async function* openaiSession(req, entry) {
  const apiKey = entry.api_key ?? (entry.env_key ? process.env[entry.env_key] : undefined);
  if (!apiKey) {
    yield frames.error(`shim: no API key for model entry (set ${entry.env_key ?? "api_key"})`, 5);
    return;
  }
  const messages = [];
  for (const m of req.messages) {
    const role = m.role === 1 ? "user" : m.role === 2 ? "assistant" : m.role === 3 ? "tool" : "system";
    let content = "";
    if (m.content === "text") content = m.text ?? "";
    else if (m.content === "parts") {
      content = (m.parts.parts ?? [])
        .map((p) => (p.part === "text" ? p.text?.text ?? "" : ""))
        .join("");
    }
    if (content) messages.push({ role, content });
  }
  const tools = (req.tools ?? []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: structToJson(t.parameters) ?? { type: "object", properties: {} },
    },
  }));
  const body = {
    model: entry.model ?? entry.id,
    stream: true,
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    ...(req.modelConfig?.maxTokens ? { max_tokens: req.modelConfig.maxTokens } : {}),
    ...(req.modelConfig?.temperature ? { temperature: req.modelConfig.temperature } : {}),
  };
  const baseUrl = (entry.base_url ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      ...(entry.extra_headers ?? {}),
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok || !resp.body) {
    const errText = (await resp.text().catch(() => "")).slice(0, 400);
    yield frames.error(`shim: upstream ${resp.status}: ${errText}`, 1);
    return;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let leftover = "";
  let outTokens = 0;
  let finishSent = false;
  let fullText = "";
  const pendingTools = new Map();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const { lines, leftover: rest } = sseLines(decoder.decode(value, { stream: true }), leftover);
    leftover = rest;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = json.choices?.[0]?.delta;
      const finish = json.choices?.[0]?.finish_reason;
      if (delta?.content) {
        outTokens++;
        fullText += delta.content;
        yield frames.text(delta.content);
      }
      for (const tc of delta?.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const pending = pendingTools.get(idx) ?? { id: "", name: "", args: "" };
        if (tc.id) pending.id = tc.id;
        if (tc.function?.name) pending.name = tc.function.name;
        if (tc.function?.arguments) pending.args += tc.function.arguments;
        pendingTools.set(idx, pending);
      }
      if (finish && !finishSent) {
        finishSent = true;
        const toolCalls = [];
        for (const [idx, t] of pendingTools) {
          const id = t.id || `shim-tc-${idx}`;
          toolCalls.push({ id, name: t.name, args: t.args });
          yield frames.toolCall({
            toolCallId: id,
            toolName: t.name,
            args: t.args,
            isComplete: true,
            toolIndex: idx,
          });
        }
        yield frames.text("", true);
        yield frames.usage(Math.max(1, json.usage?.prompt_tokens ?? 0), Math.max(1, json.usage?.completion_tokens ?? outTokens));
        yield frames.responseInfo(json.model ?? entry.model ?? entry.id, json.id, { content: fullText, toolCalls });
      }
    }
  }
  if (!finishSent) {
    yield frames.text("", true);
    yield frames.usage(1, Math.max(1, outTokens));
    yield frames.responseInfo(entry.model ?? entry.id, undefined, { content: fullText });
  }
}

export async function* runEntry(req, entry) {
  if (entry.provider === "openai-compatible") {
    yield* openaiSession(req, entry);
  } else if (entry.provider === "codex-oauth") {
    const { codexSession } = await import("./codex-oauth.mjs");
    yield* codexSession(req, entry);
  } else {
    yield* cannedSession(req);
  }
}

export async function* runSession(req) {
  const { entry } = resolveModel(req);
  yield* runEntry(req, entry);
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHIM_DIR = path.join(os.homedir(), ".codex-shim");

const out = { default: null, models: {} };

// Codex OAuth: whatever `codex login` already has access to, no API key.
const CODEX_HOME = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
if (fs.existsSync(path.join(CODEX_HOME, "auth.json"))) {
  let cached;
  try {
    cached = JSON.parse(fs.readFileSync(path.join(CODEX_HOME, "models_cache.json"), "utf8"));
  } catch {
    cached = { models: [{ slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol" }] };
  }
  for (const m of cached.models ?? []) {
    const slug = m?.slug ?? m?.id;
    if (!slug || slug === "codex-auto-review") continue;
    const id = `${m.display_name ?? slug} (Codex)`;
    out.models[id] = {
      provider: "codex-oauth",
      model: slug,
      reasoning_effort: m.default_reasoning_level ?? "medium",
    };
    out.default ??= id;
  }
}

for (const file of fs.existsSync(SHIM_DIR) ? fs.readdirSync(SHIM_DIR) : []) {
  if (!file.endsWith("-models.json") && !file.endsWith("models.json")) continue;
  let json;
  try {
    json = JSON.parse(fs.readFileSync(path.join(SHIM_DIR, file), "utf8"));
  } catch {
    continue;
  }
  const entries = Array.isArray(json.models) ? json.models : Object.values(json.models ?? {});
  for (const e of entries) {
    if (!e?.model || !e.base_url) continue;
    if (!e.api_key && !e.env_key) continue; // oauth/subscription providers not supported yet
    const id = e.display_name ?? e.model;
    const envKey =
      e.env_key ??
      (String(e.base_url).includes("openrouter.ai")
        ? "OPENROUTER_API_KEY"
        : "OPENAI_COMPATIBLE_API_KEY");
    out.models[id] = {
      provider: "openai-compatible",
      base_url: e.base_url,
      model: e.model,
      // Never copy credentials from private provider files into the generated,
      // potentially tracked catalog. Resolve them from the environment.
      env_key: envKey,
    };
    out.default ??= id;
  }
}

// Codex quota is a subscription wall, not a per-request error: when it is hit,
// serve from the first key-based entry instead of failing the turn.
const keyedFallback = Object.entries(out.models).find(
  ([, e]) => e.provider === "openai-compatible",
)?.[0];
if (keyedFallback) {
  for (const entry of Object.values(out.models)) {
    if (entry.provider === "codex-oauth") entry.fallback = keyedFallback;
  }
}

if (!out.default) {
  out.default = "canned";
  out.models.canned = { provider: "canned" };
}
fs.writeFileSync(path.join(ROOT, "models.json"), JSON.stringify(out, null, 2));
console.log(`models.json written: default=${out.default}, entries: ${Object.keys(out.models).join(", ")}`);

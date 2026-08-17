import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = protobuf.loadSync(path.join(ROOT, "shim", "models.proto"));
const AvailableModelsResponse = root.lookupType("aiserver.v1.AvailableModelsResponse");

function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "models.json"), "utf8"));
}

function presentation(id, entry) {
  const provider = entry.provider ?? "local";
  if (provider === "codex-oauth") {
    return { vendorName: "OpenAI", vendor: { id: 2, displayName: "OpenAI" }, tagline: "Via Codex subscription" };
  }
  if (provider === "openai-compatible") {
    const model = String(entry.model ?? "");
    if (model.startsWith("z-ai/")) {
      return { vendorName: "Z.ai", vendor: { id: 8, displayName: "Z.ai" }, tagline: "Via OpenAI-compatible API" };
    }
    return { vendorName: "OpenAI-compatible", vendor: { id: 0, displayName: "OpenAI-compatible" }, tagline: "Configured in models.json" };
  }
  return { vendorName: "Local", vendor: { id: 0, displayName: "Local" }, tagline: id };
}

export function availableModelsPayload() {
  const config = loadConfig();
  const names = Object.keys(config.models ?? {});
  const defaultModel = names.includes(config.default) ? config.default : names[0] ?? "canned";
  const models = names.map((id) => {
    const entry = config.models[id] ?? {};
    return {
      name: id,
      defaultOn: id === defaultModel,
      supportsAgent: true,
      supportsThinking: true,
      supportsImages: true,
      supportsAutoContext: true,
      supportsNonMaxMode: true,
      clientDisplayName: id,
      serverModelName: entry.model ?? id,
      supportsPlanMode: true,
      isUserAdded: true,
      inputboxShortModelName: id,
      supportsSandboxing: true,
      supportsCmdK: true,
      isHidden: false,
      // Settings -> Model asks for named models and explicitly filters routed
      // (Auto-tier) entries out.
      visibleInRoutedModelView: false,
      ...presentation(id, entry),
    };
  });
  const featureConfig = { defaultModel, fallbackModels: names.filter((id) => id !== defaultModel) };
  return {
    modelNames: names,
    models,
    composerModelConfig: featureConfig,
    backgroundComposerModelConfig: featureConfig,
    planExecutionModelConfig: featureConfig,
    quickAgentModelConfig: featureConfig,
    useModelParameters: false,
    displayConfiguration: { hideSearchBar: false, hideAddModels: true },
  };
}

export function encodeAvailableModels() {
  const payload = availableModelsPayload();
  const error = AvailableModelsResponse.verify(payload);
  if (error) throw new Error(`invalid AvailableModels response: ${error}`);
  return Buffer.from(AvailableModelsResponse.encode(AvailableModelsResponse.create(payload)).finish());
}

export function decodeAvailableModels(bytes) {
  return AvailableModelsResponse.toObject(AvailableModelsResponse.decode(bytes), {
    defaults: true,
    arrays: true,
    objects: true,
    enums: String,
  });
}

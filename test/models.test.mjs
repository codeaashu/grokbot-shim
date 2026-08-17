import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  availableModelsPayload,
  decodeAvailableModels,
  encodeAvailableModels,
} from "../shim/models.mjs";
import { statsigBootstrap } from "../shim/statsig.mjs";

test("the model catalog exposes the configured default", () => {
  const payload = availableModelsPayload();
  assert.equal(payload.composerModelConfig.defaultModel, "GPT-5.6-Luna (Codex)");
  assert.ok(payload.models.some((model) => model.name === "GPT-5.6-Luna (Codex)"));
  assert.ok(payload.models.every((model) => model.visibleInRoutedModelView === false));
});

test("the model catalog survives protobuf encoding", () => {
  const decoded = decodeAvailableModels(encodeAvailableModels());
  assert.equal(decoded.models.length, availableModelsPayload().models.length);
  assert.equal(decoded.composerModelConfig.defaultModel, "GPT-5.6-Luna (Codex)");
});

test("tracked model configuration contains no inline API keys", () => {
  const config = JSON.parse(fs.readFileSync(new URL("../models.json", import.meta.url), "utf8"));
  for (const entry of Object.values(config.models)) {
    assert.equal("api_key" in entry, false);
  }
});

test("Statsig bootstrap leaves model selection unallocated", () => {
  const bootstrap = statsigBootstrap();
  const config = JSON.parse(bootstrap.config);
  assert.deepEqual(config.dynamic_configs, {});
  assert.deepEqual(config.feature_gates, {});
});

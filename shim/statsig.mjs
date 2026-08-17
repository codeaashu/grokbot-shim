// Minimal Statsig V1 bootstrap understood by the packaged Sand experiment
// client. This deliberately leaves sand_model_selection unallocated: the
// current desktop's legacy Settings -> Model card yields to that experiment.
// Returning an authenticated bootstrap also clears stale cached assignments.
export function statsigBootstrap() {
  const user = {
    userID: "shim-local-user",
    email: "shim@local",
  };
  const config = {
    has_updates: true,
    time: Date.now(),
    user,
    feature_gates: {},
    dynamic_configs: {},
    layer_configs: {},
  };

  return {
    config: JSON.stringify(config),
    generatedAtMs: config.time,
  };
}

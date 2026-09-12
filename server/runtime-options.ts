import type { QuestStreamFixtureRecorder } from "./quest-stream-fixture.js";

export interface CeresServerRuntimeOptions {
  defaultRecorderRateHz?: number;
  questStreamRecorder?: QuestStreamFixtureRecorder | null;
}

let configuredOptions: CeresServerRuntimeOptions = {};
let optionsConsumed = false;

export function configureCeresServerRuntime(options: CeresServerRuntimeOptions) {
  if (optionsConsumed) throw new Error("CERES server runtime options are already active");
  configuredOptions = { ...options };
}

export function consumeCeresServerRuntimeOptions(): CeresServerRuntimeOptions {
  optionsConsumed = true;
  return { ...configuredOptions };
}

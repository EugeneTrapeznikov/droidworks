// pi-jev entry. Wires the judge into tool-result triage.
import { loadConfig } from "./telemetry.ts";
import { createJudge } from "./judge/index.ts";
import { register } from "./triage/index.ts";

export default function (pi: any) {
  const cfg = loadConfig();
  if (cfg.features.has("triage")) register(pi, createJudge(cfg), cfg);
}

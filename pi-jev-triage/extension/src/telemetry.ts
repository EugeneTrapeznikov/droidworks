import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import type { DecisionRecord, JevConfig } from "./judge/types.ts";
import { type JevSettings, pickNum, readSettings, resolveJudge } from "./settings.ts";

/** PI_JEV_* env > settings.json "pi-jev" > default. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, s: JevSettings = readSettings(env)): JevConfig {
  const j = resolveJudge(env, s);
  const features = new Set((env.PI_JEV_FEATURES ?? "triage").split(",").map(s => s.trim()).filter(Boolean)) as JevConfig["features"];
  return {
    judge: j.backend as JevConfig["judge"],
    shadow: env.PI_JEV_SHADOW !== undefined ? env.PI_JEV_SHADOW !== "0" : s.shadow ?? true,
    features,
    logPath: env.PI_JEV_LOG ?? `${homedir()}/.pi/agent/pi-jev/decisions.jsonl`,
    timeoutMs: pickNum(env.PI_JEV_TIMEOUT_MS, s.timeoutMs, 15_000),
    localUrl: j.url,
  };
}

export function record(cfg: JevConfig, rec: Omit<DecisionRecord, "ts" | "shadow">): void {
  if (!cfg.logPath) return;
  try {
    mkdirSync(dirname(cfg.logPath), { recursive: true });
    appendFileSync(cfg.logPath, JSON.stringify({ ts: new Date().toISOString(), shadow: cfg.shadow, ...rec }) + "\n");
  } catch {
    // telemetry must never break the agent
  }
}

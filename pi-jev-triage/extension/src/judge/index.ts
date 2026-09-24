// Judge factory + the two helpers every feature uses.
import { record } from "../telemetry.ts";
import type { DecisionRecord, JevConfig, Judge, JudgeRequest, JudgeResponse } from "./types.ts";
import { JudgeError } from "./shared.ts";
import { TYPESAFE_BASE_URL, TypeSafeJudge, systemOneUrl } from "./typesafe.ts";
import { VercelJudge } from "./vercel.ts";
import { MockJudge } from "./mock.ts";
import { secret } from "./dotenv.ts";

export { JudgeError } from "./shared.ts";
export { TypeSafeJudge } from "./typesafe.ts";
export { VercelJudge } from "./vercel.ts";
export { MockJudge } from "./mock.ts";

export function createJudge(cfg: JevConfig, env: Record<string, string | undefined> = process.env): Judge {
  switch (cfg.judge) {
    case "vercel":
      return new VercelJudge({ apiKey: secret("VERCEL_API_KEY", env) ?? secret("AI_GATEWAY_API_KEY", env), timeoutMs: cfg.timeoutMs });
    case "typesafe":
      return new TypeSafeJudge({
        url: env.PI_JEV_TYPESAFE_URL ?? TYPESAFE_BASE_URL,
        apiKey: secret("TYPESAFE_API_KEY", env),
        requireKey: true,
        timeoutMs: cfg.timeoutMs,
        backend: "typesafe",
      });
    case "local": {
      const base = cfg.localUrl ?? env.PI_JEV_LOCAL_URL;
      if (!base) throw new JudgeError("config", "judge=local needs PI_JEV_LOCAL_URL or a settings.json pi-jev url");
      // Same wire format as TypeSafe, no auth.
      return new TypeSafeJudge({ url: systemOneUrl(base), timeoutMs: cfg.timeoutMs, backend: "local" });
    }
    case "mock":
      return new MockJudge({ seed: env.PI_JEV_MOCK_SEED });
    default:
      throw new JudgeError("config", `unknown judge "${cfg.judge}"`);
  }
}

/** Reject with a timeout JudgeError if `p` has not settled in `ms`. Backends already abort their own
 *  fetch; this is for callers wrapping a whole decision path (judge + local work). */
export function withDeadline<T>(p: Promise<T>, ms: number, label = "judge"): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new JudgeError("timeout", `${label}: deadline ${ms}ms exceeded`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export interface AskLog {
  cfg: JevConfig;
  feature: DecisionRecord["feature"];
  /** Extra fields merged into the telemetry record. */
  detail?: Record<string, unknown>;
}

/** Fail-open: every feature calls this, never `judge.ask` directly. Null means "behave as if there is
 *  no judge". Always records latency, success or failure. */
export async function askOrNull(judge: Judge, req: JudgeRequest, log?: AskLog): Promise<JudgeResponse | null> {
  const t0 = Date.now();
  try {
    const res = await judge.ask(req);
    if (log) {
      record(log.cfg, {
        feature: log.feature,
        backend: res.backend,
        latencyMs: res.latencyMs,
        inputTokens: res.usage?.inputTokens,
        detail: { ok: true, ...log.detail },
      });
    }
    return res;
  } catch (e: any) {
    if (log) {
      record(log.cfg, {
        feature: log.feature,
        backend: judge.name,
        latencyMs: Date.now() - t0,
        detail: { ok: false, error: e instanceof JudgeError ? e.kind : "unknown", message: String(e?.message ?? e), ...log.detail },
      });
    }
    return null;
  }
}

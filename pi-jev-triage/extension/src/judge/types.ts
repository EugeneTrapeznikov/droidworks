// Shared judge contract. Every backend (Jev via Vercel/TypeSafe, local sidecar, mock)
// implements `Judge`. Every feature (triage, prefix, speculative) consumes only this file.
// Request/response mirror TypeSafe's System One shape so the same JSON can hit
// https://api.typesafe.ai/v1/systemone, a local sidecar, or be replayed offline.

export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> } // id -> description, ≤255
  | { type: "noul"; instructions: string; subject?: string }                   // yes/no, returns P(yes); `subject` = the text being judged (remote backends fold it into instructions)
  | { type: "score"; instructions: string; criteria: string[] };               // 2–10 ordered levels

export interface JudgeRequest {
  /** Task state: string, JSON object, or array of strings. Keep under ~32k tokens. */
  state: unknown;
  questions: Record<string, Question>;
  /** Hard deadline; backends must reject after this. Default 15000. */
  timeoutMs?: number;
}

export type Answer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence?: number }
  | { type: "noul"; probability: number }
  | { type: "score"; level: string; probabilities: Record<string, number> };

export interface JudgeResponse {
  answers: Record<string, Answer>;
  usage?: { inputTokens: number; outputTokens?: number };
  latencyMs: number;
  backend: string;
}

export interface Judge {
  readonly name: string;
  ask(req: JudgeRequest): Promise<JudgeResponse>;
}

/** Env-driven config shared by extension and bench. */
export interface JevConfig {
  judge: "vercel" | "typesafe" | "local" | "mock";               // PI_JEV_JUDGE
  shadow: boolean;                                                // PI_JEV_SHADOW=1 -> decide+log, never mutate
  features: Set<"triage" | "prefix" | "spec">;                    // PI_JEV_FEATURES=triage,prefix,spec
  logPath?: string;                                               // PI_JEV_LOG -> decision telemetry JSONL
  timeoutMs: number;                                              // PI_JEV_TIMEOUT_MS, default 15000
  localUrl?: string;                                              // PI_JEV_LOCAL_URL for judge=local
}

/** One line per decision in the telemetry log; the bench and the blog read this. */
export interface DecisionRecord {
  ts: string;
  feature: "triage" | "prefix" | "spec";
  backend: string;
  latencyMs: number;
  inputTokens?: number;
  shadow: boolean;
  /**
   * Feature-specific payload. These keys are read by bench/swe (moa-harness score.py) and bench/live
   * and must not be renamed: triage `bytesBefore`, `bytesAfter`; prefix `tokensSaved`,
   * `skillsSelected`, `toolsSelected` (the names prefix actually kept, tools excluding the base set);
   * spec `hit` (boolean), `bytesAppended`, `chosen`. Every record may carry `outcome`.
   */
  detail: Record<string, unknown> & {
    bytesBefore?: number; bytesAfter?: number; tokensSaved?: number;
    skillsSelected?: string[]; toolsSelected?: string[];
    hit?: boolean; bytesAppended?: number; chosen?: string[]; outcome?: string;
  };
}

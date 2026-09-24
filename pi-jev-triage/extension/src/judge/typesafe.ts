// TypeSafe System One. Our Question type is already TypeSafe's shape, so questions go 1:1 on the wire.
//
//   POST {base}/v1/systemone            Authorization: Bearer <key>   (omit for a no-auth sidecar)
//   { "model": "jev-latest", "state": <string|object|array>, "questions": { id: {type,instructions,criteria?} } }
//   -> { "model", "answers": { id: {type:"noul",noul} | {type:"choice",choice,probabilities,confidence}
//                                  | {type:"score",score,legend,probabilities,confidence} },
//        "usage": { "input_tokens", "output_tokens" } }
//
// Same class serves judge=local (PI_JEV_LOCAL_URL sidecar, no auth) and the AI Gateway
// TypeSafe-compatible base https://ai-gateway.vercel.sh/typesafe.
import type { Judge, JudgeRequest, JudgeResponse } from "./types.ts";
import { JudgeError, parseAnswers, parseUsage, postJson, wireQuestions } from "./shared.ts";

export const TYPESAFE_BASE_URL = "https://api.typesafe.ai";

/** Accepts a base URL or a full endpoint. */
export function systemOneUrl(base: string): string {
  const b = base.replace(/\/+$/, "");
  return /\/systemone$/.test(b) ? b : `${b}/v1/systemone`;
}

export interface TypeSafeOptions {
  /** Base URL or full endpoint. Default https://api.typesafe.ai */
  url?: string;
  /** Omitted -> no Authorization header, for a loopback sidecar. */
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  /** Telemetry label: "typesafe" or "local". */
  backend?: string;
  requireKey?: boolean;
}

export class TypeSafeJudge implements Judge {
  readonly name: string;
  private readonly url: string;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly requireKey: boolean;

  constructor(opts: TypeSafeOptions = {}) {
    this.name = opts.backend ?? "typesafe";
    this.url = systemOneUrl(opts.url ?? TYPESAFE_BASE_URL);
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "jev-latest";
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.requireKey = opts.requireKey ?? false;
  }

  async ask(req: JudgeRequest): Promise<JudgeResponse> {
    if (this.requireKey && !this.apiKey) {
      throw new JudgeError("config", `${this.name}: TYPESAFE_API_KEY is not set`);
    }
    if (!req.questions || Object.keys(req.questions).length === 0) {
      throw new JudgeError("config", `${this.name}: no questions in request`);
    }
    const t0 = Date.now();
    const body = await postJson(
      this.url,
      { model: this.model, state: req.state, questions: wireQuestions(req.questions) },
      req.timeoutMs ?? this.timeoutMs,
      this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {},
    );
    return {
      answers: parseAnswers(body, req.questions),
      usage: parseUsage(body),
      latencyMs: Date.now() - t0,
      backend: this.name,
    };
  }
}

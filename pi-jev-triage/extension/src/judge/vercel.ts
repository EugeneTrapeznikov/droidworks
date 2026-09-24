// Jev through Vercel AI Gateway's native evaluation HTTP API. No AI SDK needed:
// `experimental_evaluate` is a wrapper over the same endpoint.
//
//   POST https://ai-gateway.vercel.sh/v1/evaluate    Authorization: Bearer <AI Gateway key>
//   { "model": "typesafe-ai/jev", "state": <string|object|array>,
//     "questions": { id: { type: "boolean"|"choice"|"score", instructions, criteria? } } }
//   -> { "model", "answers": { id: {type:"boolean",probability} | {type:"choice",choice,probabilities}
//                                  | {type:"score",score,probabilities:{"0":..}} },
//        "usage": { "inputTokens", "outputTokens" },
//        "providerMetadata": { "gateway": { routing, cost, generationId },
//                              "typesafe": { "confidence": { id: 0.91 } } } }
//
// Gateway names yes/no `boolean`; TypeSafe (and our contract) call it `noul`. Mapped both ways here.
import type { Judge, JudgeRequest, JudgeResponse, Question } from "./types.ts";
import { JudgeError, parseAnswers, parseUsage, postJson, wireQuestions } from "./shared.ts";

export const VERCEL_EVALUATE_URL = "https://ai-gateway.vercel.sh/v1/evaluate";
export const VERCEL_JEV_MODEL = "typesafe-ai/jev";

/** noul -> boolean; choice and score go through unchanged. */
export function toGatewayQuestions(questions: Record<string, Question>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(questions).map(([id, q]) =>
      q.type === "noul" ? [id, { type: "boolean", instructions: q.instructions }] : [id, q],
    ),
  );
}

export interface VercelOptions {
  apiKey?: string;
  url?: string;
  model?: string;
  timeoutMs?: number;
}

export class VercelJudge implements Judge {
  readonly name = "vercel";
  private readonly url: string;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(opts: VercelOptions = {}) {
    this.url = opts.url ?? VERCEL_EVALUATE_URL;
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? VERCEL_JEV_MODEL;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async ask(req: JudgeRequest): Promise<JudgeResponse> {
    if (!this.apiKey) throw new JudgeError("config", "vercel: VERCEL_API_KEY is not set");
    if (!req.questions || Object.keys(req.questions).length === 0) {
      throw new JudgeError("config", "vercel: no questions in request");
    }
    const t0 = Date.now();
    let body: any;
    try {
      body = await postJson(
        this.url,
        { model: this.model, state: req.state, questions: toGatewayQuestions(wireQuestions(req.questions)) },
        req.timeoutMs ?? this.timeoutMs,
        { authorization: `Bearer ${this.apiKey}` },
      );
    } catch (e) {
      if (e instanceof JudgeError && e.detail?.includes("customer_verification_required")) {
        throw new JudgeError(
          "http",
          "vercel: customer_verification_required — AI Gateway needs a payment method on file for this team",
          e.status,
          e.detail,
        );
      }
      throw e;
    }
    return {
      answers: parseAnswers(body, req.questions, body?.providerMetadata?.typesafe?.confidence),
      usage: parseUsage(body),
      latencyMs: Date.now() - t0,
      backend: this.name,
    };
  }
}

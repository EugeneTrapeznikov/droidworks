// Deterministic answers for tests and `run.py --dry-run`. Fixtures win; anything unfixtured
// is derived from FNV-1a(seed + question id), so the same seed always gives the same answers.
import type { Answer, Judge, JudgeRequest, JudgeResponse, Question } from "./types.ts";

/** State as one string, for the token estimate. */
export function stateText(state: unknown): string {
  if (typeof state === "string") return state;
  try {
    return JSON.stringify(state) ?? String(state);
  } catch {
    return String(state);
  }
}

export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export interface MockOptions {
  seed?: string | number;
  /** Question id -> canned answer. Takes precedence over the seed. */
  fixtures?: Record<string, Answer>;
}

/** Chosen option gets 0.7, the rest split 0.3. Realistic enough to exercise thresholds. */
function peaked(keys: string[], pick: number): Record<string, number> {
  const rest = keys.length > 1 ? 0.3 / (keys.length - 1) : 0;
  const out: Record<string, number> = {};
  keys.forEach((k, i) => (out[k] = i === pick ? (keys.length > 1 ? 0.7 : 1) : rest));
  return out;
}

function answer(q: Question, h: number): Answer {
  if (q.type === "noul") return { type: "noul", probability: (h % 1000) / 1000 };
  if (q.type === "choice") {
    const ids = Object.keys(q.criteria);
    const pick = h % ids.length;
    return { type: "choice", choice: ids[pick], probabilities: peaked(ids, pick), confidence: 0.7 };
  }
  const pick = h % q.criteria.length;
  return { type: "score", level: q.criteria[pick], probabilities: peaked(q.criteria, pick) };
}

export class MockJudge implements Judge {
  readonly name = "mock";
  private readonly seed: string;
  private readonly fixtures: Record<string, Answer>;

  constructor(opts: MockOptions = {}) {
    this.seed = String(opts.seed ?? "0");
    this.fixtures = opts.fixtures ?? {};
  }

  async ask(req: JudgeRequest): Promise<JudgeResponse> {
    const answers: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      answers[id] = this.fixtures[id] ?? answer(q, hash(this.seed + "|" + id));
    }
    return {
      answers,
      usage: { inputTokens: Math.ceil(stateText(req.state).length / 4) },
      latencyMs: 0,
      backend: this.name,
    };
  }
}

// Shared plumbing for the two HTTP backends: typed errors, one fetch, one tolerant parser.
// The parser reads the *request* question types and accepts both wire dialects:
//   TypeSafe  { noul: 0.98 } | { score, legend, probabilities, confidence } | usage.input_tokens
//   Gateway   { probability } | { score, probabilities: {"0":..} }          | usage.inputTokens
import type { Answer, Question } from "./types.ts";

export type JudgeErrorKind = "timeout" | "http" | "malformed" | "config";

export class JudgeError extends Error {
  readonly kind: JudgeErrorKind;
  readonly status?: number;
  /** Response body excerpt, for diagnosing gateway/account errors. Never contains credentials. */
  readonly detail?: string;

  constructor(kind: JudgeErrorKind, message: string, status?: number, detail?: string) {
    super(message);
    this.name = "JudgeError";
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

/** POST JSON with a hard deadline covering connect + body read. Throws JudgeError, never returns partial. */
export async function postJson(
  url: string,
  body: unknown,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<any> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: ac.signal,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new JudgeError("http", `HTTP ${res.status} from ${url}`, res.status, text.slice(0, 600));
    try {
      return JSON.parse(text);
    } catch {
      throw new JudgeError("malformed", `non-JSON body from ${url}`, res.status, text.slice(0, 200));
    }
  } catch (e: any) {
    if (e instanceof JudgeError) throw e;
    if (ac.signal.aborted) throw new JudgeError("timeout", `timeout after ${timeoutMs}ms: ${url}`);
    throw new JudgeError("http", `fetch failed: ${e?.message ?? e}`);
  } finally {
    clearTimeout(timer);
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function probMap(v: unknown): Record<string, number> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, p] of Object.entries(v as Record<string, unknown>)) {
    const n = num(p);
    if (n === undefined) return undefined;
    out[k] = n;
  }
  return Object.keys(out).length ? out : undefined;
}

/** First key with the maximal value; insertion order breaks ties, so it is deterministic. */
export function argmax(p: Record<string, number>): string {
  let best = "";
  let bv = -Infinity;
  for (const [k, v] of Object.entries(p)) {
    if (v > bv) {
      bv = v;
      best = k;
    }
  }
  return best;
}

function parseOne(id: string, q: Question, a: any, confidence?: number): Answer {
  if (q.type === "noul") {
    const p = num(a.noul) ?? num(a.probability);
    if (p === undefined) throw new JudgeError("malformed", `answer "${id}": no noul/probability number`);
    return { type: "noul", probability: Math.min(1, Math.max(0, p)) };
  }

  if (q.type === "choice") {
    const probabilities = probMap(a.probabilities) ?? (typeof a.choice === "string" ? { [a.choice]: 1 } : undefined);
    if (!probabilities) throw new JudgeError("malformed", `answer "${id}": no probabilities and no choice`);
    const choice = typeof a.choice === "string" ? a.choice : argmax(probabilities);
    if (!(choice in q.criteria)) {
      throw new JudgeError("malformed", `answer "${id}": choice "${choice}" is not one of the criteria`);
    }
    const c = num(a.confidence) ?? confidence;
    return c === undefined
      ? { type: "choice", choice, probabilities }
      : { type: "choice", choice, probabilities, confidence: c };
  }

  // score: both dialects may key probabilities by level index; relabel to the criteria strings we sent.
  const levels = q.criteria;
  const legend = a.legend && typeof a.legend === "object" ? (a.legend as Record<string, unknown>) : undefined;
  const raw = probMap(a.probabilities);
  let probabilities: Record<string, number> | undefined;
  if (raw) {
    probabilities = {};
    for (const [k, v] of Object.entries(raw)) {
      const viaLegend = typeof legend?.[k] === "string" ? (legend[k] as string) : undefined;
      const viaIndex = /^\d+$/.test(k) ? levels[Number(k)] : undefined;
      const label = viaLegend ?? viaIndex ?? (levels.includes(k) ? k : undefined);
      if (label === undefined) {
        throw new JudgeError("malformed", `answer "${id}": probability key "${k}" maps to no level`);
      }
      probabilities[label] = (probabilities[label] ?? 0) + v;
    }
  } else {
    const s = num(a.score);
    if (s === undefined) throw new JudgeError("malformed", `answer "${id}": no probabilities and no score`);
    const i = Math.min(levels.length - 1, Math.max(0, Math.round(s)));
    probabilities = { [levels[i]]: 1 };
  }
  return { type: "score", level: argmax(probabilities), probabilities };
}

/** Every requested question must come back well-formed, or the whole call fails. */
export function parseAnswers(
  body: any,
  questions: Record<string, Question>,
  confidenceById?: Record<string, number>,
): Record<string, Answer> {
  const raw = body?.answers;
  if (!raw || typeof raw !== "object") throw new JudgeError("malformed", "response has no `answers` object");
  const out: Record<string, Answer> = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = raw[id];
    if (!a || typeof a !== "object") throw new JudgeError("malformed", `response has no answer for "${id}"`);
    out[id] = parseOne(id, q, a, num(confidenceById?.[id]));
  }
  return out;
}

export function parseUsage(body: any): { inputTokens: number; outputTokens?: number } | undefined {
  const u = body?.usage;
  if (!u || typeof u !== "object") return undefined;
  const inputTokens = num(u.inputTokens) ?? num(u.input_tokens);
  if (inputTokens === undefined) return undefined;
  const outputTokens = num(u.outputTokens) ?? num(u.output_tokens);
  return outputTokens === undefined ? { inputTokens } : { inputTokens, outputTokens };
}

/** Fold a noul `subject` into the instructions for backends that only know TypeSafe's three shapes. */
export function wireQuestions(questions: Record<string, Question>): Record<string, Question> {
  return Object.fromEntries(
    Object.entries(questions).map(([id, q]) =>
      q.type === "noul" && q.subject ? [id, { type: "noul", instructions: `${q.instructions}\n\nSubject:\n${q.subject}` }] : [id, q],
    ),
  ) as Record<string, Question>;
}

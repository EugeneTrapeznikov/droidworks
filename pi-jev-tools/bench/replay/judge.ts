// `judge`: replay cases through a Judge, batched exactly as the extension would
// (one call per tool result).

import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { OUT_ROOT } from "./corpus.ts";
import { casePath, type Feature, type TriageCase } from "./extract.ts";
import { createJudge } from "../../extension/src/judge/index.ts";
import type { Judge, JudgeRequest, JevConfig } from "../../extension/src/judge/types.ts";
import { loadConfig } from "../../extension/src/telemetry.ts";
import { type Block, buildQuestions, buildState, formatTask, loadTriageConfig, questionSet } from "../../extension/src/triage/core.ts";

export const JEV_USD_PER_MTOK = 0.042;
export const COST_CEILING_USD = 5;
/** `PI_JEV_BENCH_CONCURRENCY`. 8 for a hosted backend; set 1 against a single-threaded local
 *  sidecar (`kev.serve` serves one request at a time), otherwise queueing time lands in the
 *  measured latency and pushes requests past the deadline. */
const concurrency = () => Math.max(1, Number(process.env.PI_JEV_BENCH_CONCURRENCY ?? 8) || 8);

/** 4 chars/token, the same rule the cost estimate uses. */
export const estimateTokens = (req: JudgeRequest) =>
  Math.ceil((JSON.stringify(req.state).length + JSON.stringify(req.questions).length) / 4);

export const judgedPath = (f: Feature, judge: string) => join(OUT_ROOT, "judged", `${f}.${judge}.jsonl`);
export const scorePath = (f: Feature, judge: string) => join(OUT_ROOT, "scores", `${f}.${judge}.json`);

/** `PI_JEV_TIMEOUT_MS`, default 15000 — the same knob the extension reads, so nothing is hardcoded here. */
export const defaultTimeoutMs = (): number => loadConfig().timeoutMs;

export function getJudge(name: JevConfig["judge"], timeoutMs = defaultTimeoutMs()): Judge {
  return createJudge({ judge: name, shadow: true, features: new Set(), timeoutMs });
}

// --- request construction ---
//
// The extension's own request: `buildState` (task + tool + the leading run of full blocks that fits
// the judge's state cap) and `buildQuestions` (one noul per judged block, referencing `blocks.<id>`).
// Blocks past the cap get no answer and stay kept, as `decide()` treats a missing answer (P 1).

/** Task context via the extension's own `formatTask`, so both sides send the same string. */
export const taskOf = (t: { prompt: string; lastAssistant: string }) => formatTask(t.prompt, t.lastAssistant);

/** The extension's state cap for `judge` (env > settings.json > per-backend default). */
export const stateCapFor = (judge: string): number => loadTriageConfig({ ...process.env, PI_JEV_JUDGE: judge }).stateCap;

/** A case's blocks in the extension's `Block` shape (ids `b<i>`, split-line char ranges kept). */
export const caseBlocks = (t: TriageCase): Block[] =>
  t.blocks.map(b => ({ id: `b${b.i}`, start: b.startLine, end: b.endLine, text: b.text, ...(b.from !== undefined && { from: b.from, to: b.to }) }));

/** One request per case, or none when not even the first block fits the cap. */
export function buildRequests(t: TriageCase, timeoutMs: number, stateCap: number): JudgeRequest[] {
  const blocks = caseBlocks(t);
  const state = buildState(taskOf(t.task), blocks, stateCap, t.tool);
  const judged = blocks.filter(b => b.id in state.blocks);
  if (!judged.length) return [];
  // Same questions as the extension, error gate included (PI_JEV_QUESTION_SET picks the wording).
  return [{ state, questions: buildQuestions(judged, questionSet()), timeoutMs }];
}

// --- pass 1: cheap line scan for cost estimate + stratification ---

interface LineMeta { n: number; tokens: number; stratum: string }

function stratumOf(line: string): string {
  const pos = line.includes('"needed":true') ? "pos" : "neg";
  const size = line.length < 8_000 ? "s" : line.length < 40_000 ? "m" : "l";
  return `${pos}-${size}`;
}

export async function scanCases(f: Feature): Promise<LineMeta[]> {
  const p = casePath(f);
  if (!existsSync(p)) throw new Error(`no cases at ${p}; run extract --feature ${f} first`);
  const rl = createInterface({ input: createReadStream(p, { encoding: "utf8" }), crlfDelay: Infinity });
  const out: LineMeta[] = [];
  let n = 0;
  for await (const line of rl) { if (line) out.push({ n: n++, tokens: Math.ceil(line.length / 4), stratum: stratumOf(line) }); }
  return out;
}

/** Round-robin across strata so small buckets survive the sample. */
export function stratifiedPick(metas: LineMeta[], n: number): Set<number> {
  const by = new Map<string, LineMeta[]>();
  for (const m of metas) (by.get(m.stratum) ?? by.set(m.stratum, []).get(m.stratum)!).push(m);
  const keys = [...by.keys()].sort();
  const picked = new Set<number>();
  for (let i = 0; picked.size < n; i++) {
    let progressed = false;
    for (const k of keys) {
      const arr = by.get(k)!;
      if (i >= arr.length) continue;
      progressed = true;
      picked.add(arr[i].n);
      if (picked.size >= n) break;
    }
    if (!progressed) break;
  }
  return picked;
}

export const usd = (tokens: number) => (tokens * JEV_USD_PER_MTOK) / 1e6;

// --- pass 2: run ---

export const RETRY_STATUS = new Set([429, 502, 503]);
export const retryCounts: Record<string, number> = {};
/** Hosted Jev sheds load with 429 "upstream provider is currently experiencing high demand".
 *  Retry the case with exponential backoff (30 s start, 5 min cap, jitter). A case that still fails
 *  is not written, so no fail-open answer ever reaches scoring; a rerun resumes it. */
/** Circuit breaker: over the last `PI_JEV_BENCH_WINDOW` (50) attempts, a success rate under
 *  `PI_JEV_BENCH_MIN_SUCCESS` (0.5) trips it. Tripped: no new cases start, retries stop, the
 *  run exits 3 so a driver can pause and re-probe. Unfinished cases are never written. */
const WINDOW = Number(process.env.PI_JEV_BENCH_WINDOW ?? 50);
const MIN_SUCCESS = Number(process.env.PI_JEV_BENCH_MIN_SUCCESS ?? 0.5);
const outcomes: boolean[] = [];
export const breaker = { tripped: false };
export function noteAttempt(ok: boolean) {
  outcomes.push(ok);
  if (outcomes.length > WINDOW) outcomes.shift();
  if (outcomes.length === WINDOW && outcomes.filter(Boolean).length / WINDOW < MIN_SUCCESS) breaker.tripped = true;
}

export async function askWithBackoff(judge: Judge, req: JudgeRequest, attempts = 20, baseMs = 30_000, capMs = 300_000) {
  for (let k = 0; ; k++) {
    if (breaker.tripped) throw new Error("breaker tripped: success rate under threshold");
    try { const r = await judge.ask(req); noteAttempt(true); return r; }
    catch (e: any) {
      noteAttempt(false);
      const key = e?.kind === "timeout" ? "timeout" : String(e?.status);
      if (k + 1 >= attempts || breaker.tripped || !(RETRY_STATUS.has(e?.status) || e?.kind === "timeout")) throw e;
      retryCounts[key] = (retryCounts[key] ?? 0) + 1;
      await Bun.sleep(Math.min(capMs, baseMs * 2 ** k) * (0.5 + Math.random()));
    }
  }
}

export interface JudgedRecord { id: string; feature: Feature; backend: string; requests: number; latencyMs: number; inputTokens: number; answers: Record<string, any> }

export interface RunOpts { feature: Feature; judge: JevConfig["judge"]; limit?: number; sample?: "stratified"; sampleN?: number; yes?: boolean; timeoutMs?: number }

export async function runJudge(o: RunOpts): Promise<{ estimatedTokens: number; estimatedUsd: number; ran: number; skipped: number }> {
  const metas = await scanCases(o.feature);
  let selected: Set<number> | null = null;
  if (o.sample === "stratified") selected = stratifiedPick(metas, o.sampleN ?? 2000);
  let chosen = metas.filter(m => !selected || selected.has(m.n));
  if (o.limit) chosen = chosen.slice(0, o.limit);
  const estimatedTokens = chosen.reduce((a, m) => a + m.tokens, 0);
  const estimatedUsd = usd(estimatedTokens);
  console.log(`cases=${chosen.length} est_input_tokens=${estimatedTokens.toLocaleString()} est_jev_cost=$${estimatedUsd.toFixed(4)}`);
  const billed = o.judge === "vercel" || o.judge === "typesafe";
  if (billed && estimatedUsd > COST_CEILING_USD && !o.yes) {
    throw new Error(`estimated $${estimatedUsd.toFixed(2)} exceeds the $${COST_CEILING_USD} ceiling; rerun with --yes`);
  }

  const out = judgedPath(o.feature, o.judge);
  mkdirSync(join(OUT_ROOT, "judged"), { recursive: true });
  const done = new Set<string>();
  if (existsSync(out)) {
    for (const line of readFileSync(out, "utf8").split("\n")) {
      const m = /^\{"id":"([^"]+)"/.exec(line);
      if (m) done.add(m[1]);
    }
  }

  const timeoutMs = o.timeoutMs ?? defaultTimeoutMs();
  const conc = concurrency();
  const judge = getJudge(o.judge, timeoutMs);
  const stateCap = stateCapFor(o.judge);
  const ws = createWriteStream(out, { flags: "a" });
  const want = new Set(chosen.map(m => m.n));

  let ran = 0, skipped = 0, n = 0;
  const inflight = new Set<Promise<void>>();
  const rl = createInterface({ input: createReadStream(casePath(o.feature), { encoding: "utf8" }), crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line) continue;
    const idx = n++;
    if (!want.has(idx)) continue;
    let c: TriageCase;
    try { c = JSON.parse(line); } catch { continue; }
    if (done.has(c.id)) { skipped++; continue; }
    if (breaker.tripped) break;
    const reqs = buildRequests(c, timeoutMs, stateCap);
    const task = (async () => {
      try {
        const answers: Record<string, any> = {};
        let latencyMs = 0, inputTokens = 0;
        for (const req of reqs) {
          const res = await askWithBackoff(judge, req);
          Object.assign(answers, res.answers);
          latencyMs += res.latencyMs;
          inputTokens += res.usage?.inputTokens ?? estimateTokens(req);
        }
        const rec: JudgedRecord = { id: c.id, feature: o.feature, backend: judge.name, requests: reqs.length, latencyMs: Math.round(latencyMs * 100) / 100, inputTokens, answers };
        ws.write(JSON.stringify(rec) + "\n");
        ran++;
      } catch (e) {
        console.error(`  judge failed on ${c.id}: ${(e as Error).message}`);
      }
    })();
    inflight.add(task);
    task.finally(() => inflight.delete(task));
    if (inflight.size >= conc) await Promise.race(inflight);
    if (ran && ran % (o.judge === "vercel" ? 100 : 5000) === 0) console.error(`  ...judged ${ran} ${new Date().toISOString()} retries ${JSON.stringify(retryCounts)}`);
  }
  await Promise.all(inflight);
  if (breaker.tripped) { console.error(`  BREAKER TRIPPED: <${MIN_SUCCESS * 100}% success over last ${WINDOW} attempts; stopped`); process.exitCode = 3; }
  if (Object.keys(retryCounts).length) console.error(`  retries by cause: ${JSON.stringify(retryCounts)}`);
  await new Promise<void>(res => ws.end(() => res()));
  return { estimatedTokens, estimatedUsd, ran, skipped };
}

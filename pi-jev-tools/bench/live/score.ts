#!/usr/bin/env bun
// Score a bench/live results directory into RESULTS.md.
//
//   bun score.ts --in results/<ts> [--out RESULTS.md]
//
// Per arm: first-turn prefix (mean/median, Δ vs `off`), calls, tokens, cost, judge latency
// p50/p95, and triage bytes hidden / recall turns from the DecisionRecords.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { loadRoutingSet, type RoutingSet, type RunResult } from "./run.ts";

const HERE = dirname(new URL(import.meta.url).pathname);

export function pct(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}
export const median = (xs: number[]) => pct([...xs].sort((a, b) => a - b), 50);
export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// --- triage ---------------------------------------------------------------
export interface TriageScore {
  /** judged tool results (every `triage` DecisionRecord) */
  decisions: number;
  bytesBefore: number;
  bytesAfter: number;
  /** 1 - after/before over every triaged result, so error-gate and skip-ratio passes count as 0% hidden */
  hiddenPct: number | null;
  pruned: number;
  errorGate: number;
  skipRatio: number;
  failOpen: number;
  /** `pi_jev_recall` tool calls: the turns the agent spent buying hidden text back */
  recallTurns: number;
}

export function scoreTriage(runs: RunResult[]): TriageScore {
  const t: TriageScore = { decisions: 0, bytesBefore: 0, bytesAfter: 0, hiddenPct: null, pruned: 0, errorGate: 0, skipRatio: 0, failOpen: 0, recallTurns: 0 };
  for (const r of runs) {
    t.recallTurns += r.toolCalls?.pi_jev_recall ?? 0;
    for (const d of (r.decisions ?? []) as any[]) {
      if (d?.feature !== "triage") continue;
      t.decisions++;
      t.bytesBefore += d.detail?.bytesBefore ?? 0;
      t.bytesAfter += d.detail?.bytesAfter ?? d.detail?.bytesBefore ?? 0;
      const o = d.detail?.outcome;
      if (o === "pruned") t.pruned++;
      else if (o === "errorgate") t.errorGate++;
      else if (o === "skip_ratio") t.skipRatio++;
      else if (o === "failopen") t.failOpen++;
    }
  }
  if (t.bytesBefore > 0) t.hiddenPct = 1 - t.bytesAfter / t.bytesBefore;
  return t;
}

export interface ArmScore {
  arm: string;
  n: number;
  failures: number;
  /** prefix size = first-turn input + first-turn cacheRead (implicit caching makes billed input alone incomparable) */
  firstMean: number | null;
  firstMedian: number | null;
  deltaVsOff: number | null;
  /** billed first-turn input over the cold (cacheRead == 0) subset only */
  coldN: number;
  coldMedian: number | null;
  callsMean: number | null;
  totalInput: number;
  totalCacheRead: number;
  cost: number;
  /** input + cacheRead + output, per ok run */
  tokensPerRun: number | null;
  stubsPerRun: number | null;
  recallPerRun: number | null;
  timedOut: number;
  wallMedianS: number | null;
  judgeP50: number | null;
  judgeP95: number | null;
  triage: TriageScore;
}

export function scoreArm(arm: string, runs: RunResult[], offMedian: number | null): ArmScore {
  const ok = runs.filter(r => r.ok);
  const firsts = ok
    .filter(r => typeof r.firstTurnInput === "number")
    .map(r => (r.firstTurnInput as number) + (r.firstTurnCacheRead ?? 0));
  const cold = ok
    .filter(r => typeof r.firstTurnInput === "number" && !r.firstTurnCacheRead)
    .map(r => r.firstTurnInput as number);
  const latencies = runs
    .flatMap(r => (r.decisions ?? []) as any[])
    .filter(d => d?.feature === "triage" && typeof d.latencyMs === "number")
    .map(d => d.latencyMs as number)
    .sort((a, b) => a - b);

  const median50 = median(firsts);
  return {
    arm,
    n: runs.length,
    failures: runs.length - ok.length,
    firstMean: mean(firsts),
    firstMedian: median50,
    deltaVsOff: median50 !== null && offMedian !== null ? median50 - offMedian : null,
    coldN: cold.length,
    coldMedian: median(cold),
    callsMean: mean(ok.map(r => r.calls)),
    totalInput: ok.reduce((a, r) => a + r.totalInput, 0),
    totalCacheRead: ok.reduce((a, r) => a + r.totalCacheRead, 0),
    cost: runs.reduce((a, r) => a + r.cost, 0),
    tokensPerRun: mean(ok.map(r => r.totalInput + r.totalCacheRead + r.totalOutput)),
    stubsPerRun: mean(ok.map(r => r.stubs ?? 0)),
    recallPerRun: mean(ok.map(r => r.toolCalls?.pi_jev_recall ?? 0)),
    timedOut: runs.filter(r => r.timedOut).length,
    wallMedianS: median(ok.map(r => r.wallMs / 1000)),
    judgeP50: pct(latencies, 50),
    judgeP95: pct(latencies, 95),
    triage: scoreTriage(runs),
  };
}

export function loadResults(dir: string): Map<string, RunResult[]> {
  const out = new Map<string, RunResult[]>();
  for (const arm of readdirSync(dir, { withFileTypes: true })) {
    if (!arm.isDirectory()) continue;
    const runs: RunResult[] = [];
    for (const f of readdirSync(join(dir, arm.name))) {
      if (!f.endsWith(".json")) continue;
      runs.push(JSON.parse(readFileSync(join(dir, arm.name, f), "utf8")));
    }
    if (runs.length) out.set(arm.name, runs.sort((a, b) => a.id.localeCompare(b.id)));
  }
  return out;
}

const n0 = (x: number | null, d = 0) => (x === null ? "—" : x.toFixed(d));
const ms = (x: number | null) => (x === null ? "—" : `${x.toFixed(0)} ms`);
const pc = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(0)}%`);

export function renderMarkdown(scores: ArmScore[], set: RoutingSet, dir: string, models = "(unrecorded)"): string {
  const L: string[] = [];
  L.push("# pi-jev live bench (Tier 2)");
  L.push("");
  L.push(`Generated ${new Date().toISOString()} from \`${dir}\`.`);
  L.push("");
  L.push(`Rig: \`pi -p --session-dir <tmp> --no-context-files <prompt>\` from a fixed scratch fixture repo, user's normal extensions and skills ON, model ${models}. ${set.items.length}-prompt set (\`routing-set.json\`).`);
  L.push("");
  L.push("## Cost and context per arm");
  L.push("");
  L.push("First-turn prefix = `usage.input + usage.cacheRead` on the first model call. The provider caches prefixes implicitly **across** sessions, so billed `input` alone swings ~2× between otherwise identical runs; the cold column is the billed subset where `cacheRead == 0`.");
  L.push("");
  L.push("| arm | n | fail | first-turn prefix mean | median | Δ median vs off | cold n | cold billed median | calls/run | tokens/run | Σ input | Σ cacheRead | cost (retail-equiv.) | wall p50 | timedOut |");
  L.push("|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
  for (const s of scores) {
    L.push(`| \`${s.arm}\` | ${s.n} | ${s.failures} | ${n0(s.firstMean)} | ${n0(s.firstMedian)} | ${s.deltaVsOff === null ? "—" : (s.deltaVsOff >= 0 ? "+" : "") + s.deltaVsOff.toFixed(0)} | ${s.coldN} | ${n0(s.coldMedian)} | ${n0(s.callsMean, 1)} | ${n0(s.tokensPerRun)} | ${s.totalInput.toLocaleString()} | ${s.totalCacheRead.toLocaleString()} | $${s.cost.toFixed(2)} | ${n0(s.wallMedianS, 1)}s | ${s.timedOut} |`);
  }
  L.push("");
  const triaged = scores.filter(s => s.triage.decisions > 0);
  if (triaged.length) {
    L.push("## Triage");
    L.push("");
    L.push("`bytes hidden %` is `1 − Σ bytesAfter / Σ bytesBefore` over every judged tool result, so an error-gate or below-ratio pass counts as 0% hidden rather than dropping out. `recall turns` counts `pi_jev_recall` tool calls in the transcript — the turns the agent spent buying hidden text back.");
    L.push("");
    L.push("| arm | results judged | judge p50 | judge p95 | Σ before | Σ after | bytes hidden % | pruned | error-gate | skip<ratio | fail-open | stubs/run | recall/run |");
    L.push("|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
    for (const s of triaged) {
      const t = s.triage;
      L.push(`| \`${s.arm}\` | ${t.decisions} | ${ms(s.judgeP50)} | ${ms(s.judgeP95)} | ${t.bytesBefore.toLocaleString()} | ${t.bytesAfter.toLocaleString()} | ${pc(t.hiddenPct)} | ${t.pruned} | ${t.errorGate} | ${t.skipRatio} | ${t.failOpen} | ${n0(s.stubsPerRun, 2)} | ${n0(s.recallPerRun, 2)} |`);
    }
    L.push("");
  }

  // hand-written findings live in notes.md so a re-score never clobbers them
  const notes = join(HERE, "notes.md");
  if (existsSync(notes)) L.push(readFileSync(notes, "utf8").trimEnd(), "");
  return L.join("\n");
}

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

if (import.meta.main) {
  const dir = flag("in");
  if (!dir || !existsSync(dir)) throw new Error("--in <results dir> required");
  const set = loadRoutingSet();
  const byArm = loadResults(dir);
  const off = byArm.get("off");
  const offMedian = off
    ? median(off.filter(r => r.ok && typeof r.firstTurnInput === "number").map(r => (r.firstTurnInput as number) + (r.firstTurnCacheRead ?? 0)))
    : null;
  const scores = [...byArm.entries()]
    .sort(([a], [b]) => (a === "off" ? -1 : b === "off" ? 1 : a.localeCompare(b)))
    .map(([arm, runs]) => scoreArm(arm, runs, offMedian));
  const models = [...new Set([...byArm.values()].flat().map(r => (r.model ? `\`${r.provider}/${r.model}\`` : "(unrecorded)")))].join(", ");
  const md = renderMarkdown(scores, set, dir, models);
  const out = flag("out", join(HERE, "RESULTS.md")) as string;
  writeFileSync(out, md);
  console.log(md);
  console.error(`wrote ${out}`);
}

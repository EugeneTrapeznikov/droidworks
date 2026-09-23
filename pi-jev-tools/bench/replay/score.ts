// `score`: join cases with judged probabilities and compute the Tier 1 metrics.
// Streams both files and keeps only histograms, so a multi-GB triage set scores in constant memory.

import { createReadStream, existsSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { OUT_ROOT } from "./corpus.ts";
import { casePath, TCFG, type Feature, type TriageCase } from "./extract.ts";
import { caseBlocks, judgedPath, scorePath } from "./judge.ts";
import { decide, ERROR_GATE, joinBlocks, prob } from "../../extension/src/triage/core.ts";

export const DROP_THRESHOLDS = [0.05, 0.1, 0.2, 0.3];

// --- calibration primitives (tested) ---

export class Hist {
  readonly bins: number;
  pos: Float64Array;
  neg: Float64Array;
  sump: Float64Array;
  constructor(bins = 1000) {
    this.bins = bins;
    this.pos = new Float64Array(bins);
    this.neg = new Float64Array(bins);
    this.sump = new Float64Array(bins);
  }
  add(p: number, label: boolean) {
    const i = Math.min(this.bins - 1, Math.max(0, Math.floor(p * this.bins)));
    (label ? this.pos : this.neg)[i]++;
    this.sump[i] += p;
  }
  get totals() {
    let P = 0, N = 0;
    for (let i = 0; i < this.bins; i++) { P += this.pos[i]; N += this.neg[i]; }
    return { P, N };
  }
  /** Mann-Whitney AUC from the histogram, ties counted at half weight. */
  auc(): number {
    const { P, N } = this.totals;
    if (!P || !N) return NaN;
    let negBelow = 0, acc = 0;
    for (let i = 0; i < this.bins; i++) {
      acc += this.pos[i] * (negBelow + 0.5 * this.neg[i]);
      negBelow += this.neg[i];
    }
    return acc / (P * N);
  }
  /** Expected calibration error over `k` equal-width bins. */
  ece(k = 10): number {
    const per = this.bins / k;
    const { P, N } = this.totals;
    const total = P + N;
    if (!total) return NaN;
    let e = 0;
    for (let b = 0; b < k; b++) {
      let n = 0, pos = 0, sump = 0;
      for (let i = b * per; i < (b + 1) * per; i++) { n += this.pos[i] + this.neg[i]; pos += this.pos[i]; sump += this.sump[i]; }
      if (!n) continue;
      e += (n / total) * Math.abs(pos / n - sump / n);
    }
    return e;
  }
}

// --- judged-file index: id -> [offset, length], so we never hold answers in memory ---

async function indexJudged(path: string): Promise<Map<string, [number, number]>> {
  const idx = new Map<string, [number, number]>();
  if (!existsSync(path)) throw new Error(`no judged file at ${path}; run judge first`);
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  let off = 0;
  for await (const line of rl) {
    const len = Buffer.byteLength(line, "utf8");
    const m = /^\{"id":"([^"]+)"/.exec(line);
    if (m) idx.set(m[1], [off, len]);
    off += len + 1;
  }
  return idx;
}

function reader(path: string) {
  const fd = openSync(path, "r");
  return (off: number, len: number) => {
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, off);
    return JSON.parse(buf.toString("utf8"));
  };
}

/** Judge cost/latency, streamed alongside the metrics: one entry per case, summing the requests a
 *  case needed — the same unit the extension pays per decision. */
export class JudgeStats {
  private lat: number[] = [];
  private tokens = 0;
  private cases = 0;
  private requests = 0;
  add(rec: any) {
    if (typeof rec?.latencyMs === "number") this.lat.push(rec.latencyMs);
    this.tokens += typeof rec?.inputTokens === "number" ? rec.inputTokens : 0;
    this.requests += typeof rec?.requests === "number" ? rec.requests : 1;
    this.cases++;
  }
  get summary() {
    const s = this.lat.slice().sort((a, b) => a - b);
    const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN);
    return {
      cases: this.cases,
      requests: this.requests,
      latencyP50: q(0.5),
      latencyP95: q(0.95),
      inputTokensTotal: this.tokens,
      inputTokensPerCase: this.tokens / (this.cases || 1),
    };
  }
}

async function eachJoined(feature: Feature, judge: string, cb: (c: any, answers: Record<string, any>, rec?: any) => void) {
  const jp = judgedPath(feature, judge);
  const idx = await indexJudged(jp);
  const read = reader(jp);
  const rl = createInterface({ input: createReadStream(casePath(feature), { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const m = /^\{"id":"([^"]+)"/.exec(line);
    const hit = m && idx.get(m[1]);
    if (!hit) continue;
    let c: any;
    try { c = JSON.parse(line); } catch { continue; }
    const rec = read(hit[0], hit[1]);
    cb(c, rec.answers ?? {}, rec);
  }
}

// --- per-feature scoring ---

async function scoreTriage(judge: string) {
  const h = new Hist();
  let cases = 0, blocks = 0, needed = 0, chars = 0;
  const drop = DROP_THRESHOLDS.map(() => ({ chars: 0, blocks: 0, neededHidden: 0 }));
  // The shipped policy, run through the extension's own `decide`: head/tail pinned, error gate,
  // and the 20% minimum prune ratio that makes a case a no-op.
  const pol = { pruned: 0, errorGate: 0, skipRatio: 0, charsBefore: 0, charsHidden: 0, neededHidden: 0, uncertain: 0 };
  const stats = new JudgeStats();
  await eachJoined("triage", judge, (c: TriageCase, a, rec) => {
    cases++; stats.add(rec);
    const probs: Record<string, number> = {};
    for (const b of c.blocks) {
      const p = a[`b${b.i}`]?.probability;
      if (typeof p !== "number") continue;
      probs[`b${b.i}`] = p;
      blocks++; chars += b.chars; if (b.needed) needed++;
      h.add(p, b.needed);
      DROP_THRESHOLDS.forEach((t, i) => {
        if (p <= t) { drop[i].chars += b.chars; drop[i].blocks++; if (b.needed) drop[i].neededHidden++; }
      });
    }
    // Blocks past the state cap were never asked; decide() keeps them (missing answer = P 1).
    if (!Object.keys(probs).length) return;
    const eb = caseBlocks(c);
    const text = joinBlocks(eb);
    // The judge's own error answer, read exactly as the extension reads it (missing = 1 = keep all).
    const errProb = prob(a[ERROR_GATE]);
    const d = decide(eb, probs, errProb, TCFG);
    pol.charsBefore += text.length;
    if (d.errorGate) { pol.errorGate++; return; }
    if (d.hiddenChars / (text.length || 1) < TCFG.minPruneRatio) { pol.skipRatio++; return; }
    pol.pruned++; pol.charsHidden += d.hiddenChars; pol.uncertain += d.uncertain;
    c.blocks.forEach((b, i) => { if (d.hidden[i] && b.needed) pol.neededHidden++; });
  });
  return {
    feature: "triage", judge, cases, blocks, neededBlocks: needed,
    neededShare: needed / (blocks || 1), totalChars: chars,
    auc: h.auc(), ece: h.ece(10),
    thresholds: DROP_THRESHOLDS.map((t, i) => ({
      drop: t,
      bytesHiddenPct: (100 * drop[i].chars) / (chars || 1),
      blocksHiddenPct: (100 * drop[i].blocks) / (blocks || 1),
      recallNeeded: 1 - drop[i].neededHidden / (needed || 1),
      regretBlocks: drop[i].neededHidden,
      regretPct: (100 * drop[i].neededHidden) / (needed || 1),
    })),
    policy: {
      drop: TCFG.drop, keep: TCFG.keep, minPruneRatio: TCFG.minPruneRatio,
      prunedCases: pol.pruned, errorGateCases: pol.errorGate, skipRatioCases: pol.skipRatio,
      bytesHiddenPct: (100 * pol.charsHidden) / (pol.charsBefore || 1),
      recallNeeded: 1 - pol.neededHidden / (needed || 1),
      regretBlocks: pol.neededHidden,
      uncertainBlocks: pol.uncertain,
    },
    judge_: stats.summary,
  };
}

export async function runScore(feature: Feature, judge: string) {
  const r = await scoreTriage(judge);
  mkdirSync(join(OUT_ROOT, "scores"), { recursive: true });
  writeFileSync(scorePath(feature, judge), JSON.stringify(r, null, 2));
  return r;
}

// --- markdown ---

const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : "n/a");
const num = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const int = (x: number) => (Number.isFinite(x) ? Math.round(x).toLocaleString() : "n/a");
const ms = (x: number) => (Number.isFinite(x) ? `${Math.round(x)} ms` : "n/a");

/** One line of judge cost per score block: latency per decision and what it was billed for. */
const judgeLine = (r: any): string => {
  const j = r.judge_;
  if (!j) return "";
  return `\nJudge cost per case — one case is one decision, ${(j.requests / (j.cases || 1)).toFixed(2)} ` +
    `request(s), summed: latency p50 ${ms(j.latencyP50)} / p95 ${ms(j.latencyP95)}, ` +
    `input ${int(j.inputTokensPerCase)} tokens (${int(j.inputTokensTotal)} total over ${int(j.cases)} cases).\n`;
};

/** Per-feature head-to-head: one column per judge over the same sampled cases. */
export function comparisonTable(feature: Feature, scores: any[]): string {
  const rows: Array<[string, (r: any) => string]> = [
    ["cases / blocks", r => `${int(r.cases)} / ${int(r.blocks)}`],
    ["AUC", r => num(r.auc)],
    ["ECE", r => num(r.ece)],
    ["sweep @drop 0.1: bytes hidden", r => `${r.thresholds[1].bytesHiddenPct.toFixed(1)}%`],
    ["sweep @drop 0.1: recall of needed", r => pct(r.thresholds[1].recallNeeded)],
    ["**shipped** pruned / error gate / under ratio", r => `${int(r.policy.prunedCases)} / ${int(r.policy.errorGateCases)} / ${int(r.policy.skipRatioCases)}`],
    ["**shipped** bytes hidden", r => `${r.policy.bytesHiddenPct.toFixed(1)}%`],
    ["**shipped** recall of needed", r => pct(r.policy.recallNeeded)],
    ["**shipped** regret / uncertain blocks", r => `${int(r.policy.regretBlocks)} / ${int(r.policy.uncertainBlocks)}`],
  ];

  rows.push(
    ["judge latency p50 / p95", r => (r.judge_ ? `${ms(r.judge_.latencyP50)} / ${ms(r.judge_.latencyP95)}` : "n/a")],
    ["judge input tokens per case", r => (r.judge_ ? int(r.judge_.inputTokensPerCase) : "n/a")],
    ["judge input tokens total", r => (r.judge_ ? int(r.judge_.inputTokensTotal) : "n/a")],
  );

  const head = `| ${feature} | ${scores.map(s => s.judge).join(" | ")} |`;
  const sep = `|---|${scores.map(() => "---:").join("|")}|`;
  const body = rows.map(([label, f]) => `| ${label} | ${scores.map(s => { try { return f(s); } catch { return "n/a"; } }).join(" | ")} |`);
  return [head, sep, ...body].join("\n") + "\n";
}

export function toMarkdown(r: any): string {
  const head = `**triage / ${r.judge}** — ${r.cases.toLocaleString()} results, ${r.blocks.toLocaleString()} blocks, ${pct(r.neededShare)} needed, ${(r.totalChars / 1e6).toFixed(1)} MB. AUC ${num(r.auc)}, ECE ${num(r.ece)}.\n\n`;
  const rows = r.thresholds.map((t: any) =>
    `| ${t.drop} | ${t.bytesHiddenPct.toFixed(1)}% | ${t.blocksHiddenPct.toFixed(1)}% | ${pct(t.recallNeeded)} | ${t.regretBlocks.toLocaleString()} (${t.regretPct.toFixed(1)}%) |`).join("\n");
  const p = r.policy;
  const tail = !p ? "" :
    `\nShipped policy (\`decide()\` at drop ${p.drop} / keep ${p.keep} / minPruneRatio ${p.minPruneRatio}, head and tail pinned, error gate on):\n\n` +
    `| pruned | error gate | under prune ratio | bytes hidden | recall of needed | regret | uncertain |\n|---:|---:|---:|---:|---:|---:|---:|\n` +
    `| ${p.prunedCases.toLocaleString()} | ${p.errorGateCases.toLocaleString()} | ${p.skipRatioCases.toLocaleString()} | ${p.bytesHiddenPct.toFixed(1)}% | ${pct(p.recallNeeded)} | ${p.regretBlocks.toLocaleString()} | ${p.uncertainBlocks.toLocaleString()} |\n` +
    `\nThe error gate withholds ${pct(p.errorGateCases / (r.cases || 1))} of results. It is the judge's answer to the error\n` +
    `question (P ≥ 0.5, or no answer, keeps the whole result), as in the extension.\n`;
  return head + `Raw per-block threshold sweep (ranker quality, no policy):\n\n| drop ≤ | bytes hidden | blocks hidden | recall of needed | regret |\n|---:|---:|---:|---:|---:|\n${rows}\n` + tail + judgeLine(r);
}

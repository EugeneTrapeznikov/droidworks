// Session replay: how much context real Pi sessions would have carried with triage on.
// Walks each session in write order, sends every eligible tool result to the real judge exactly as
// extension/src/triage/core.ts builds it, and keeps two timelines (original, triaged). Each recorded
// model call is measured against both. No model re-run: later turns are the original ones.
//
//   PI_JEV_JUDGE=vercel bun run bench/session-replay/replay.ts [--top 20] [--date 2026-09-23]
//
// Read-only on ~/.pi/agent/sessions. Writes results-<date>.md, decisions-<date>.jsonl and
// flagged-<date>.md (raw hidden text, for hand review) next to this file.

import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Judge, JudgeRequest, JudgeResponse } from "../../extension/src/judge/types.ts";
import {
	type Block,
	ERROR_GATE,
	type TriageConfig,
	buildQuestions,
	buildState,
	cacheKey,
	contentText,
	decide,
	detectStructured,
	formatTask,
	loadTriageConfig,
	matchesTool,
	pickPrompt,
	prob,
	rewrite,
	splitBlocks,
} from "../../extension/src/triage/core.ts";

export const ROOT = process.env.PI_JEV_SESSIONS ?? join(homedir(), ".pi/agent/sessions");
export const FALLBACK_CPT = 3.3;
/** Tokens every call carries with triage on: the <pi-jev> system-prompt section + pi_jev_recall schema. */
export const OVERHEAD_TOKENS = 155;
export const TIMEOUT_MS = 15_000;
export const JEV_USD_PER_MTOK = 0.042;
const EXCLUDE = ["bench", "pi-jev", "swe", ".session/", "scratchpad"];

// --- session parsing (same rules as scripts/project-triage-savings.py) ---

/** What a message puts into the next call's context: text parts and tool-call arguments, thinking excluded. */
export function visibleChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let n = 0;
	for (const p of content) {
		if (p?.type === "text" && typeof p.text === "string") n += p.text.length;
		else if (p?.type === "toolCall") n += JSON.stringify(p.arguments ?? "").length;
	}
	return n;
}

const isCall = (m: any) => m?.role === "assistant" && ((m.usage?.input ?? 0) + (m.usage?.cacheRead ?? 0)) > 0;

function readEntries(path: string): any[] {
	const out: any[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (line[0] !== "{") continue;
		try {
			out.push(JSON.parse(line));
		} catch {}
	}
	return out;
}

/** Top-level session files over 50 KB (the mining scripts' set), ranked by model calls; benchmark runs excluded. */
export function pickSessions(top: number, root = ROOT) {
	const all: { path: string; cwd: string; calls: number }[] = [];
	for (const d of readdirSync(root)) {
		let names: string[];
		try {
			names = readdirSync(join(root, d));
		} catch {
			continue;
		}
		for (const f of names) {
			const path = join(root, d, f);
			if (!f.endsWith(".jsonl") || statSync(path).size <= 50_000) continue;
			let cwd = "";
			let calls = 0;
			for (const e of readEntries(path)) {
				if (e.type === "session") cwd = e.cwd ?? "";
				else if (e.type === "message" && isCall(e.message)) calls++;
			}
			all.push({ path, cwd, calls });
		}
	}
	all.sort((a, b) => b.calls - a.calls);
	const bad = (s: { path: string; cwd: string }) => EXCLUDE.some((x) => s.path.includes(x) || s.cwd.includes(x));
	const picked = all.filter((s) => !bad(s)).slice(0, top);
	const cutoff = picked.at(-1)?.calls ?? 0;
	return { picked, excluded: all.filter((s) => bad(s) && s.calls >= cutoff) };
}

/** A logged judged decision as a judge response (block probabilities + error gate). */
function fromCache(d: Decision): JudgeResponse {
	const answers = Object.fromEntries(Object.entries(d.probs ?? {}).map(([k, v]) => [k, { type: "noul" as const, probability: v }]));
	return { answers: { ...answers, [ERROR_GATE]: { type: "noul", probability: d.err ?? 1 } }, latencyMs: d.latencyMs ?? 0, backend: "cache", usage: { inputTokens: d.jevTokens ?? 0 } };
}

// --- harm proxy ---

/** Identifiers: >= 6 chars after trailing punctuation is stripped, with a letter and `_`, `/`, or camelCase. */
export function identifiers(text: string): string[] {
	const out = new Set<string>();
	for (const raw of text.match(/[A-Za-z0-9_./-]{6,}/g) ?? []) {
		const s = raw.replace(/[./-]+$/, "");
		if (s.length >= 6 && /[A-Za-z]/.test(s) && (/[_/]/.test(s) || /[a-z][A-Z]/.test(s))) out.add(s);
	}
	return [...out];
}

// --- replay ---

/** One judge request; resolves null on failure (fail open). `attempts` counts HTTP tries. */
export type Ask = (req: JudgeRequest) => Promise<{ res: JudgeResponse | null; attempts: number }>;

export interface Decision {
	session: string;
	entry: string;
	/** Model calls in the session before this result. */
	call: number;
	tool: string;
	chars: number;
	blocks?: number;
	/** Per-block chars, block order. */
	blockChars?: number[];
	/** Error-question P(yes). */
	err?: number;
	judged?: number;
	outcome: "skip_structured" | "failopen" | "errorgate" | "skip_ratio" | "pruned";
	attempts?: number;
	latencyMs?: number;
	jevTokens?: number;
	dropped?: number;
	hiddenChars?: number;
	charsAfter: number;
	probs?: Record<string, number>;
}

export interface HiddenBlock {
	session: string;
	entry: string;
	tool: string;
	lines: string;
	text: string;
	matches: string[];
}

export interface SessionResult {
	path: string;
	cwd: string;
	calls: number;
	compactions: number;
	eligible: number;
	judged: number;
	failOpens: number;
	structured: number;
	pruned: number;
	errorGated: number;
	skipRatio: number;
	/** Eligible results a compaction removed before the session ended. */
	evicted: number;
	/** Mean model calls each eligible result was in context for. */
	sendsMean: number;
	eligibleChars: number;
	judgedChars: number;
	hiddenChars: number;
	stubs: number;
	cpt: number;
	savedPctLast: number;
	savedPctMean: number;
	savedInput: number;
	savedCacheRead: number;
	costSaved: number;
	costOriginal: number;
	flagged: number;
	jevTokens: number;
	latencies: number[];
	decisions: Decision[];
	hidden: HiddenBlock[];
}

export interface ReplayOpts {
	/** Earlier decisions by `session|entry`; a judged one is replayed without a judge call. */
	cached?: Map<string, Decision>;
	/** Called with each new decision as it happens. */
	log?: (d: Decision) => void;
}

export async function replaySession(path: string, ask: Ask, tcfg: TriageConfig, opts: ReplayOpts = {}): Promise<SessionResult> {
	if (tcfg.maxBlocksPerCall > 0) throw new Error("chunked judge calls are not replayed; unset maxBlocksPerCall");
	const ents = readEntries(path);
	const pos = new Map<string, number>();
	ents.forEach((e, i) => e.id && pos.set(e.id, i));
	const r: SessionResult = {
		path, cwd: ents.find((e) => e.type === "session")?.cwd ?? "", calls: 0, compactions: 0, eligible: 0, judged: 0,
		failOpens: 0, structured: 0, pruned: 0, errorGated: 0, skipRatio: 0, evicted: 0, sendsMean: 0, eligibleChars: 0, judgedChars: 0, hiddenChars: 0, stubs: 0, cpt: FALLBACK_CPT,
		savedPctLast: 0, savedPctMean: 0, savedInput: 0, savedCacheRead: 0, costSaved: 0, costOriginal: 0, flagged: 0,
		jevTokens: 0, latencies: [], decisions: [], hidden: [],
	};
	const session = path.split("/").slice(-2).join("/");
	// timeline items: entry index, original chars, triaged chars
	type Item = { i: number; o: number; t: number; sends: number };
	let tl: Item[] = [];
	const elig: Item[] = [];
	const add = (i: number, o: number, t = o, eligible = false) => {
		const x = { i, o, t, sends: 0 };
		tl.push(x);
		if (eligible) elig.push(x);
	};
	const calls: { o: number; t: number; u: any }[] = [];
	const prompts: string[] = [];
	const args = new Map<string, any>();
	let assistant = "";
	// later text for the harm proxy: assistant text + tool-call inputs, with the entry index each starts at
	let later = "";
	const laterAt: { i: number; off: number }[] = [];
	const hiddenAt: { i: number; b: Omit<HiddenBlock, "matches"> }[] = [];

	for (let i = 0; i < ents.length; i++) {
		const e = ents[i];
		if (e.type === "compaction") {
			const cut = pos.get(e.firstKeptEntryId) ?? i;
			r.evicted += tl.filter((x) => x.i < cut && elig.includes(x)).length;
			tl = tl.filter((x) => x.i >= cut);
			add(i, String(e.summary ?? "").length);
			r.compactions++;
			continue;
		}
		if (e.type === "custom_message") {
			add(i, visibleChars(e.content));
			continue;
		}
		if (e.type !== "message") continue;
		const m = e.message;
		if (m.role === "user") prompts.push(contentText(m.content));
		if (m.role === "assistant") {
			if (isCall(m)) {
				let o = 0, t = 0;
				for (const x of tl) (o += x.o), (t += x.t), x.sends++;
				calls.push({ o, t, u: m.usage });
			}
			assistant = contentText(m.content) || assistant;
			const tail: string[] = [contentText(m.content)];
			for (const c of Array.isArray(m.content) ? m.content : []) {
				if (c?.type !== "toolCall") continue;
				args.set(c.id, c.arguments);
				tail.push(JSON.stringify(c.arguments ?? ""));
			}
			laterAt.push({ i, off: later.length });
			later += tail.join("\n") + "\n";
		}
		const o = visibleChars(m.content);
		if (m.role !== "toolResult") {
			add(i, o);
			continue;
		}

		// --- the extension's tool_result gate (core.ts makeHandler) ---
		const parts: any[] = Array.isArray(m.content) ? m.content : [];
		let idx = -1;
		parts.forEach((c, k) => {
			if (c?.type === "text" && typeof c.text === "string" && (idx < 0 || c.text.length > parts[idx].text.length)) idx = k;
		});
		const text: string = idx >= 0 ? parts[idx].text : "";
		const tool: string = m.toolName ?? "";
		if (m.isError || !matchesTool(tool, tcfg.tools) || text.length < tcfg.minChars) {
			add(i, o);
			continue;
		}
		const key = `${session}|${e.id}`;
		const hit = opts.cached?.get(key);
		const push = (d: Decision) => {
			r.decisions.push(d);
			if (hit?.outcome !== d.outcome || d.outcome === "failopen") opts.log?.(d);
		};
		const base = { session, entry: e.id, call: calls.length, tool, chars: text.length };
		if (tcfg.skipStructured && detectStructured(text)) {
			r.structured++;
			push({ ...base, outcome: "skip_structured", charsAfter: text.length });
			add(i, o);
			continue;
		}
		const a = args.get(m.toolCallId);
		const firstLine = tool === "read" && a?.offset !== undefined && !Number.isNaN(Number(a.offset)) ? Number(a.offset) : 1;
		const blocks: Block[] = splitBlocks(text, tcfg.blockLines, firstLine, tcfg.blockChars);
		if (blocks.length < 3) {
			add(i, o);
			continue;
		}
		const state = buildState(formatTask(pickPrompt(prompts), assistant), blocks, tcfg.stateCap, tool);
		const judged = blocks.filter((b) => b.id in state.blocks);
		if (!judged.length) {
			add(i, o);
			continue;
		}
		r.eligible++;
		r.eligibleChars += text.length;
		const { res, attempts } = hit?.probs
			? { res: fromCache(hit), attempts: hit.attempts ?? 0 }
			: await ask({ state, questions: buildQuestions(judged, tcfg.questions), timeoutMs: TIMEOUT_MS });
		const more = { blocks: blocks.length, judged: judged.length, attempts, blockChars: blocks.map((b) => b.text.length) };
		if (!res) {
			r.failOpens++;
			push({ ...base, ...more, outcome: "failopen", charsAfter: text.length });
			add(i, o, o, true);
			continue;
		}
		r.judged++;
		r.judgedChars += text.length;
		r.latencies.push(res.latencyMs);
		const jevTokens = res.usage?.inputTokens ?? Math.ceil(JSON.stringify(state).length / 4);
		r.jevTokens += jevTokens;
		const probs: Record<string, number> = {};
		for (const b of blocks) probs[b.id] = prob(res.answers?.[b.id]);
		const errProb = prob(res.answers?.[ERROR_GATE]);
		const d = decide(blocks, probs, errProb, tcfg);
		const info = { ...base, ...more, latencyMs: res.latencyMs, jevTokens, dropped: d.dropped, hiddenChars: d.hiddenChars, err: errProb, probs };
		const kept = d.errorGate ? "errorgate" : d.hiddenChars / text.length < tcfg.minPruneRatio ? "skip_ratio" : null;
		if (kept) {
			if (kept === "errorgate") r.errorGated++;
			else r.skipRatio++;
			push({ ...info, hiddenChars: 0, outcome: kept, charsAfter: text.length });
			add(i, o, o, true);
			continue;
		}
		const pruned = rewrite(blocks, d.hidden, cacheKey(m.toolCallId ?? "", text));
		r.pruned++;
		r.hiddenChars += d.hiddenChars;
		r.stubs += d.hidden.filter((h, k) => h && !d.hidden[k - 1]).length;
		push({ ...info, outcome: "pruned", charsAfter: pruned.length });
		add(i, o, o - text.length + pruned.length, true);
		blocks.forEach((b, k) => d.hidden[k] && hiddenAt.push({ i, b: { session, entry: e.id, tool, lines: `${b.start}-${b.end}`, text: b.text } }));
	}

	r.sendsMean = elig.length ? elig.reduce((n, x) => n + x.sends, 0) / elig.length : 0;

	// harm proxy: an identifier from a hidden block reappears in the original session's later assistant text or tool inputs
	for (const { i, b } of hiddenAt) {
		const from = laterAt.find((x) => x.i > i)?.off ?? later.length;
		const matches = identifiers(b.text).filter((id) => later.indexOf(id, from) >= 0);
		if (matches.length) r.flagged++;
		r.hidden.push({ ...b, matches });
	}

	// tokens: this session's own tokens per context char; price at each call's own recorded rates
	const tok = calls.reduce((n, c) => n + (c.u.input ?? 0) + (c.u.cacheRead ?? 0), 0);
	const chars = calls.reduce((n, c) => n + c.o, 0);
	const cpt = tok && chars ? chars / tok : 0;
	r.cpt = cpt >= 1.5 && cpt <= 8 ? cpt : FALLBACK_CPT;
	const pct: number[] = [];
	for (const c of calls) {
		const inp = c.u.input ?? 0, cr = c.u.cacheRead ?? 0, cost = c.u.cost ?? {};
		let ri = inp ? (cost.input ?? 0) / inp : 0, rr = cr ? (cost.cacheRead ?? 0) / cr : 0;
		ri ||= rr;
		rr ||= ri;
		const gross = (c.o - c.t) / r.cpt;
		const sIn = (gross * inp) / (inp + cr) - (cr ? 0 : OVERHEAD_TOKENS);
		const sCr = (gross * cr) / (inp + cr) - (cr ? OVERHEAD_TOKENS : 0);
		r.savedInput += sIn;
		r.savedCacheRead += sCr;
		r.costSaved += sIn * ri + sCr * rr;
		r.costOriginal += (cost.input ?? 0) + (cost.cacheRead ?? 0);
		pct.push((sIn + sCr) / (inp + cr));
	}
	r.calls = calls.length;
	r.savedPctLast = pct.at(-1) ?? 0;
	r.savedPctMean = pct.length ? pct.reduce((a, b) => a + b, 0) / pct.length : 0;
	return r;
}

// --- report ---

export const quantile = (xs: number[], q: number) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : 0;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const p = (x: number) => `${(x * 100).toFixed(1)}%`;
const k = (x: number) => (Math.abs(x) >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : `${(x / 1e3).toFixed(0)}k`);
const usd = (x: number) => `$${x.toFixed(2)}`;
const name = (r: SessionResult) => `${r.cwd.replace(homedir(), "~")} ${r.path.split("_").at(-1)!.slice(-12, -6)}`;

export function report(rs: SessionResult[], meta: { date: string; excluded: string[]; wallS: number; retries: Record<string, number>; interim?: boolean }) {
	const rows = rs.map((r) => [
		name(r), r.calls, r.eligible, r.judged, r.failOpens, p(r.eligibleChars ? r.hiddenChars / r.eligibleChars : 0),
		p(r.savedPctLast), p(r.savedPctMean), k(r.savedInput), k(r.savedCacheRead), usd(r.costSaved), r.stubs, r.flagged, r.cpt.toFixed(2),
	]);
	const table = (head: string[], body: unknown[][]) =>
		[`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...body.map((b) => `| ${b.join(" | ")} |`)].join("\n");
	const agg = (label: string, f: (r: SessionResult) => number, fmt: (x: number) => string) => {
		const xs = rs.map(f);
		return [label, fmt(quantile(xs, 0.5)), fmt(quantile(xs, 0.9)), fmt(mean(xs))];
	};
	const hid = (r: SessionResult) => (r.eligibleChars ? r.hiddenChars / r.eligibleChars : 0);
	const sum = (f: (r: SessionResult) => number) => rs.reduce((a, r) => a + f(r), 0);
	const lat = rs.flatMap((r) => r.latencies);
	const judged = sum((r) => r.judged);
	const jevUsd = (sum((r) => r.jevTokens) * JEV_USD_PER_MTOK) / 1e6;
	const bySaved = [...rs].sort((a, b) => b.savedPctMean - a.savedPctMean);
	const line = (r: SessionResult) => `- ${name(r)}: ${p(r.savedPctMean)} mean, ${p(r.savedPctLast)} at last call, ${usd(r.costSaved)} saved`;
	const flaggedAll = rs.flatMap((r) => r.hidden);
	const why = (r: SessionResult) => {
		const n = Math.max(1, r.eligible);
		return `| ${name(r)} | ${p(r.savedPctMean)} | ${r.eligible} | ${p(r.errorGated / n)} | ${p(r.skipRatio / n)} | ${p(r.failOpens / n)} | ${p(r.pruned / n)} | ${p(r.evicted / n)} | ${r.sendsMean.toFixed(0)} | ${p(r.judgedChars ? r.hiddenChars / r.judgedChars : 0)} |`;
	};
	return `# Session replay, ${meta.date}${meta.interim ? ` (INTERIM, n=${rs.length} of 20 sessions)` : ""}

Top ${rs.length} Pi sessions by model calls, replayed through the real hosted Jev judge (\`PI_JEV_JUDGE=vercel\`, winnow question set, 80k state cap, drop <= 0.1, error gate >= 0.5, < 20% hidden skips). Generated by \`replay.ts\`; per-result decisions in \`decisions-${meta.date}.jsonl\`.

Saved % is net of the 155-token/call recall overhead, over the call's recorded input+cacheRead tokens. Cost is retail-equivalent at each call's recorded rates; these sessions ran on a subscription.

${table(["session", "calls", "eligible", "judged", "fail-open", "hidden chars", "saved last call", "saved mean/call", "tok saved input", "tok saved cacheRead", "cost saved", "stubs", "flagged blocks", "chars/tok"], rows)}

## Aggregate (across sessions)

${table(["metric", "p50", "p90", "mean"], [
	agg("hidden chars / eligible chars", hid, p),
	agg("context saved, last call", (r) => r.savedPctLast, p),
	agg("context saved, mean over calls", (r) => r.savedPctMean, p),
	agg("tokens saved (input + cacheRead)", (r) => r.savedInput + r.savedCacheRead, k),
	agg("cost saved", (r) => r.costSaved, usd),
])}

- Calls ${sum((r) => r.calls)}, eligible results ${sum((r) => r.eligible)}, judged ${judged}, fail-open ${sum((r) => r.failOpens)}, structured skips ${sum((r) => r.structured)}, compactions ${sum((r) => r.compactions)}.
- Hide rate: ${p(sum((r) => r.hiddenChars) / sum((r) => r.judgedChars))} of judged-result chars (tier 3: 16%), ${p(sum((r) => r.hiddenChars) / sum((r) => r.eligibleChars))} of eligible chars incl. fail-opens; ${p(sum((r) => r.pruned) / Math.max(1, judged))} of judged results pruned, ${p(sum((r) => r.errorGated) / Math.max(1, judged))} error-gated, ${p(sum((r) => r.skipRatio) / Math.max(1, judged))} under the 20% prune ratio.
- Tokens saved: ${k(sum((r) => r.savedInput))} input, ${k(sum((r) => r.savedCacheRead))} cacheRead. Cost saved ${usd(sum((r) => r.costSaved))} of ${usd(sum((r) => r.costOriginal))} input+cacheRead cost (${p(sum((r) => r.costSaved) / sum((r) => r.costOriginal))}).
- Judge latency p50 ${quantile(lat, 0.5).toFixed(0)} ms, p95 ${quantile(lat, 0.95).toFixed(0)} ms. Retries by cause: ${JSON.stringify(meta.retries)}.
- Jev cost: ${usd(jevUsd)} (${k(sum((r) => r.jevTokens))} input tokens at $${JEV_USD_PER_MTOK}/M). Wall time ${(meta.wallS / 60).toFixed(1)} min.
- Harm proxy: ${sum((r) => r.flagged)} of ${flaggedAll.length} hidden blocks have an identifier reappearing in later assistant text or tool inputs.

Biggest savers (mean/call):
${bySaved.slice(0, 3).map(line).join("\n")}

Smallest savers:
${bySaved.slice(-3).reverse().map(line).join("\n")}

Where eligible results went (share of eligible results; evicted = removed by an original compaction before session end; sends = mean calls an eligible result stayed in context):

| session | saved mean/call | eligible | error-gated | < 20% ratio | fail-open | pruned | evicted | sends | hide rate (judged) |
|---|---|---|---|---|---|---|---|---|---|
${bySaved.map(why).join("\n")}

Excluded as benchmark runs (would have ranked in the top ${rs.length}): ${meta.excluded.length ? meta.excluded.join(", ") : "none"}.

## Caveats

- No model re-run: every later turn is the original one. A hidden block the model needed would have cost a \`pi_jev_recall\` call (or a different trajectory) that this replay cannot see; the harm proxy is the only signal for that.
- Compaction: the original sessions compacted; both timelines drop entries before \`firstKeptEntryId\` and add the summary. Triage would have shifted when compaction fires; this replay keeps the original compaction points.
- Branches are replayed in write order, not resolved through \`parentId\`.
- Tokens per char is each session's recorded input+cacheRead over its transcript chars. The system prompt is not in the transcript chars, so the ratio slightly overstates tokens per transcript char, and savings with it.
- Stub overhead: 155 tokens/call (system-prompt section + recall schema) is subtracted on every call, from cacheRead when the call had any; stub text itself is in the triaged timeline.
- Fail-open results (judge error after 5 attempts, 15 s each) count as untouched.
`;
}

export function flaggedReport(rs: SessionResult[], n = 10): string {
	const top = rs.flatMap((r) => r.hidden).filter((h) => h.matches.length).sort((a, b) => b.matches.length - a.matches.length).slice(0, n);
	return `# Flagged hidden blocks (top ${top.length} by identifier overlap)\n\nRaw session text; not for commit.\n\n${top
		.map((h) => `## ${h.session} ${h.entry} ${h.tool} lines ${h.lines}\n\nLater mentions (${h.matches.length}): ${h.matches.slice(0, 20).map((m) => `\`${m}\``).join(", ")}\n\n\`\`\`\n${h.text}\n\`\`\``)
		.join("\n\n")}\n`;
}

/** Jev probability distribution and drop-threshold what-if over logged judged decisions. */
export function probsReport(ds: Decision[], thresholds = [0.1, 0.15, 0.2, 0.25, 0.3], minPruneRatio = 0.2): string {
	const judged = ds.filter((d) => d.probs && d.blockChars);
	const blockP = judged.flatMap((d) => Array.from({ length: d.judged ?? 0 }, (_, i) => d.probs![`b${i}`] ?? 1));
	const errP = judged.map((d) => d.err ?? 1);
	const hist = (xs: number[], w: number) => {
		const n = Math.round(1 / w);
		const c = new Array(n).fill(0);
		for (const x of xs) c[Math.min(n - 1, Math.floor(x / w + 1e-9))]++;
		return `| bin | count | share |\n|---|---|---|\n${c.map((v, i) => `| ${(i * w).toFixed(2)}–${((i + 1) * w).toFixed(2)} | ${v} | ${p(v / Math.max(1, xs.length))} |`).join("\n")}`;
	};
	const stats = (xs: number[]) => `min ${quantile(xs, 0).toFixed(3)}, p10 ${quantile(xs, 0.1).toFixed(3)}, p25 ${quantile(xs, 0.25).toFixed(3)}, median ${quantile(xs, 0.5).toFixed(3)}, p75 ${quantile(xs, 0.75).toFixed(3)}`;
	const le = (xs: number[]) => thresholds.map((t) => `<= ${t.toFixed(2)}: ${p(xs.filter((x) => x <= t + 1e-9).length / Math.max(1, xs.length))}`).join(", ");
	const total = judged.reduce((n, d) => n + d.chars, 0);
	const whatIf = thresholds.map((t) => {
		let hidden = 0, pruned = 0;
		for (const d of judged) {
			if ((d.err ?? 1) >= 0.5) continue;
			const bc = d.blockChars!;
			let h = 0;
			for (let i = 1; i < bc.length - 1; i++) if ((d.probs![`b${i}`] ?? 1) <= t + 1e-9) h += bc[i]!;
			if (h / d.chars >= minPruneRatio) (hidden += h), pruned++;
		}
		return `| ${t.toFixed(2)} | ${p(hidden / Math.max(1, total))} | ${pruned} (${p(pruned / Math.max(1, judged.length))}) |`;
	});
	return `# Jev probabilities, session replay (${judged.length} judged results, ${blockP.length} judged blocks)

## Block question P(yes), 0.05 bins

${stats(blockP)}. Share ${le(blockP)}.

${hist(blockP, 0.05)}

## Error question P(yes), 0.1 bins

${stats(errP)}. Error gate (>= 0.5) fires on ${p(errP.filter((x) => x >= 0.5).length / Math.max(1, errP.length))}.

${hist(errP, 0.1)}

## Drop-threshold what-if (first/last block kept, error gate >= 0.5, >= ${minPruneRatio * 100}% prune ratio)

| drop <= | hidden, % of judged chars | results pruned |
|---|---|---|
${whatIf.join("\n")}
`;
}

const readDecisions = (path: string): Decision[] => {
	try {
		return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	} catch {
		return [];
	}
};

// --- main ---

if (import.meta.main) {
	// No circuit breaker: a failed result fails open and is counted, as the extension would.
	process.env.PI_JEV_BENCH_MIN_SUCCESS ??= "0";
	process.env.PI_JEV_JUDGE ??= "vercel";
	const { askWithBackoff, getJudge, retryCounts } = await import("../replay/judge.ts");
	const argv = process.argv.slice(2);
	const opt = (f: string, d: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1]! : d);
	const top = Number(opt("--top", "20"));
	const date = opt("--date", new Date().toISOString().slice(0, 10));
	const dir = import.meta.dir;
	const decisionsPath = join(dir, `decisions-${date}.jsonl`);
	if (argv.includes("--probs")) {
		writeFileSync(opt("--probs", ""), probsReport(readDecisions(decisionsPath)));
		process.exit(0);
	}
	// resume: judged decisions already on disk are replayed without a judge call; later lines win
	const cached = new Map(readDecisions(decisionsPath).map((d) => [`${d.session}|${d.entry}`, d]));
	const log = (d: Decision) => appendFileSync(decisionsPath, JSON.stringify(d) + "\n");
	const tcfg = loadTriageConfig();
	const t0 = Date.now();
	const inner: Judge = getJudge(process.env.PI_JEV_JUDGE as any, TIMEOUT_MS);
	const ask: Ask = async (req) => {
		let attempts = 0;
		const counted: Judge = { name: inner.name, ask: (q) => (attempts++, inner.ask(q)) };
		const ok = await askWithBackoff(counted, req, 5, 5_000, 60_000).catch(() => null);
		if (++done % 100 === 0) console.error(`  ...${done} results ${((Date.now() - t0) / 60e3).toFixed(1)} min, fail-open ${(failed += ok ? 0 : 1)}, retries ${JSON.stringify(retryCounts)}`);
		else if (!ok) failed++;
		return { res: ok, attempts };
	};
	let done = 0, failed = 0;
	const { picked, excluded } = pickSessions(top);
	console.error(`sessions ${picked.length}; excluded ${excluded.length}; judge ${inner.name}; stateCap ${tcfg.stateCap}; cached ${cached.size}; log ${decisionsPath}`);
	const meta = (interim?: boolean) => ({ date, excluded: excluded.map((s) => `${s.cwd} (${s.calls} calls)`), wallS: (Date.now() - t0) / 1000, retries: retryCounts, interim });
	let finished = 0;
	const results: SessionResult[] = new Array(picked.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: 4 }, async () => {
			while (next < picked.length) {
				const j = next++;
				results[j] = await replaySession(picked[j]!.path, ask, tcfg, { cached, log });
				const r = results[j]!;
				console.error(`  [${j + 1}/${picked.length}] ${name(r)} calls ${r.calls} judged ${r.judged}/${r.eligible} failopen ${r.failOpens} saved ${p(r.savedPctMean)}`);
				if (++finished === 10 && picked.length > 10) {
					writeFileSync(join(dir, `results-${date}.md`), report(results.filter(Boolean), meta(true)));
					console.error(`  INTERIM written: results-${date}.md (n=10)`);
				}
			}
		}),
	);
	writeFileSync(decisionsPath, results.flatMap((r) => r.decisions).map((d) => JSON.stringify(d)).join("\n") + "\n");
	writeFileSync(join(dir, `flagged-${date}.md`), flaggedReport(results));
	const md = report(results, meta());
	writeFileSync(join(dir, `results-${date}.md`), md);
	console.log(md);
}

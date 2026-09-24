// Session replay: how much context real Pi sessions would have carried with triage on.
// Walks each session in write order, sends every eligible tool result to the real judge exactly as
// extension/src/triage/core.ts builds it, and keeps two timelines (original, triaged). Each recorded
// model call is measured against both. No model re-run: later turns are the original ones.
//
//   PI_JEV_JUDGE=vercel bun run bench/session-replay/replay.ts [--top 20] [--date 2026-09-23]
//
// Read-only on ~/.pi/agent/sessions. Writes results-<date>.md, decisions-<date>.jsonl and
// flagged-<date>.md (raw hidden text, for hand review) next to this file.

import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

/** An entry's text as the model sees it: text parts and tool-call arguments (untrimmed, so a part can be replaced). */
function entryText(e: any): string {
	if (e.type === "compaction") return String(e.summary ?? "");
	const c = e.type === "custom_message" ? e.content : e.type === "message" ? e.message?.content : "";
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c.map((p: any) => (p?.type === "text" && typeof p.text === "string" ? p.text : p?.type === "toolCall" ? JSON.stringify(p.arguments ?? "") : "")).join("\n");
}

/** A logged judged decision as a judge response (block probabilities + error gate). */
function fromCache(d: Decision): JudgeResponse {
	const answers = Object.fromEntries(Object.entries(d.probs ?? {}).map(([k, v]) => [k, { type: "noul" as const, probability: v }]));
	return { answers: { ...answers, [ERROR_GATE]: { type: "noul", probability: d.err ?? 1 } }, latencyMs: d.latencyMs ?? 0, backend: "cache", usage: { inputTokens: d.jevTokens ?? 0 } };
}

/**
 * Chars per token from growth between consecutive calls with no compaction between them: chars added
 * to the transcript over tokens the recorded context grew by (the rule in scripts/project-triage-savings.py).
 * Independent of the system prompt and of pruning outside the transcript. Outside 1.5–8, or under 5,000
 * tokens of growth, falls back to 3.3.
 */
export function charsPerToken(ents: any[]): number {
	let gapChars = 0, gapTok = 0, gap = 0, last: number | null = null, clean = true;
	for (const e of ents) {
		if (e.type === "compaction") clean = false;
		if (e.type === "custom_message") gap += visibleChars(e.content);
		if (e.type !== "message") continue;
		const m = e.message;
		if (!isCall(m)) {
			gap += visibleChars(m.content);
			continue;
		}
		const ctx = m.usage.input + (m.usage.cacheRead ?? 0);
		if (clean && last !== null && ctx > last) (gapChars += gap), (gapTok += ctx - last);
		last = ctx;
		gap = visibleChars(m.content);
		clean = true;
	}
	const cpt = gapTok > 5000 ? gapChars / gapTok : 0;
	return cpt >= 1.5 && cpt <= 8 ? cpt : FALLBACK_CPT;
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
	/** First mention lands within the next 3 model calls. */
	soon: boolean;
	/** A later `read` of the same path covers these lines. */
	recalled: boolean;
	/** A returning identifier was not visible anywhere in the triaged transcript before it returned. */
	uniqueLoss: boolean;
}

export interface SessionResult {
	/** Abstract label (S01…) for anything that goes into git. */
	label: string;
	path: string;
	/** Eligible results with no logged decision (offline replay only). */
	missing: number;
	ctxTokens: number;
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
	/** Eligible results dropped because the recorded context was smaller than the timeline (pruned outside the transcript). */
	prunedOutside: number;
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
	/** Never call the judge: a result without a judged decision fails open (missing ones are counted). */
	offline?: boolean;
}

export async function replaySession(path: string, ask: Ask, tcfg: TriageConfig, opts: ReplayOpts = {}): Promise<SessionResult> {
	if (tcfg.maxBlocksPerCall > 0) throw new Error("chunked judge calls are not replayed; unset maxBlocksPerCall");
	const ents = readEntries(path);
	const pos = new Map<string, number>();
	ents.forEach((e, i) => e.id && pos.set(e.id, i));
	const r: SessionResult = {
		label: "", missing: 0, ctxTokens: 0, path, cwd: ents.find((e) => e.type === "session")?.cwd ?? "", calls: 0, compactions: 0, eligible: 0, judged: 0,
		failOpens: 0, structured: 0, pruned: 0, errorGated: 0, skipRatio: 0, evicted: 0, prunedOutside: 0, sendsMean: 0, eligibleChars: 0, judgedChars: 0, hiddenChars: 0, stubs: 0, cpt: FALLBACK_CPT,
		savedPctLast: 0, savedPctMean: 0, savedInput: 0, savedCacheRead: 0, costSaved: 0, costOriginal: 0, flagged: 0,
		jevTokens: 0, latencies: [], decisions: [], hidden: [],
	};
	const session = path.split("/").slice(-2).join("/");
	// timeline items: entry index, original chars, triaged chars
	r.cpt = charsPerToken(ents);
	/** Chars the first call carried beyond the transcript (system prompt, tool schemas). */
	let sysChars: number | undefined;
	type Item = { i: number; o: number; t: number; sends: number };
	// Everything the model could see in the triaged transcript, and where each entry starts in it
	let vis = "";
	let cur = "";
	const visOff: number[] = [];
	let tl: Item[] = [];
	const elig: Item[] = [];
	const add = (i: number, o: number, t = o, eligible = false) => {
		const x = { i, o, t, sends: 0 };
		tl.push(x);
		vis += cur + "\n";
		if (eligible) elig.push(x);
	};
	const calls: { o: number; t: number; u: any }[] = [];
	const prompts: string[] = [];
	const args = new Map<string, any>();
	let assistant = "";
	// later text for the harm proxy: assistant text + tool-call inputs, with the entry index each starts at
	let later = "";
	const laterAt: { i: number; off: number; call: number }[] = [];
	const reads: { i: number; path: string; from: number; to: number }[] = [];
	const hiddenAt: { i: number; call: number; path?: string; start: number; end: number; b: Omit<HiddenBlock, "matches" | "soon" | "recalled" | "uniqueLoss"> }[] = [];

	for (let i = 0; i < ents.length; i++) {
		const e = ents[i];
		visOff[i] = vis.length;
		cur = entryText(e);
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
				// Context pruned outside the transcript (no compaction entry): the recorded call is smaller than the
				// timeline. Drop the oldest tool results from both timelines until it fits.
				// ponytail: oldest-first guess at what was pruned; exact only if the pruner's rule is replayed
				const room = (m.usage.input + (m.usage.cacheRead ?? 0)) * r.cpt;
				let o = tl.reduce((n, x) => n + x.o, 0);
				sysChars ??= Math.max(0, room - o);
				for (let k = 0; k < tl.length && o > room - sysChars; k++) {
					const x = tl[k]!;
					if (ents[x.i]?.message?.role !== "toolResult") continue;
					o -= x.o;
					if (elig.includes(x)) r.prunedOutside++;
					tl.splice(k--, 1);
				}
				let t = 0;
				o = 0;
				for (const x of tl) (o += x.o), (t += x.t), x.sends++;
				calls.push({ o, t, u: m.usage });
			}
			assistant = contentText(m.content) || assistant;
			const tail: string[] = [contentText(m.content)];
			for (const c of Array.isArray(m.content) ? m.content : []) {
				if (c?.type !== "toolCall") continue;
				args.set(c.id, c.arguments);
				const ca = c.arguments ?? {};
				if (c.name === "read" && typeof ca.path === "string") {
					const from = Number(ca.offset) || 1;
					reads.push({ i, path: ca.path, from, to: Number(ca.limit) ? from + Number(ca.limit) - 1 : Infinity });
				}
				tail.push(JSON.stringify(c.arguments ?? ""));
			}
			laterAt.push({ i, off: later.length, call: calls.length });
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
		if (opts.offline && !hit) r.missing++;
		const { res, attempts } = hit?.probs
			? { res: fromCache(hit), attempts: hit.attempts ?? 0 }
			: opts.offline
			? { res: null, attempts: 0 }
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
		cur = cur.replace(text, () => pruned);
		add(i, o, o - text.length + pruned.length, true);
		blocks.forEach((b, k) => d.hidden[k] && hiddenAt.push({ i, call: base.call, path: tool === "read" ? a?.path : undefined, start: b.start, end: b.end, b: { session, entry: e.id, tool, lines: `${b.start}-${b.end}`, text: b.text } }));
	}

	r.sendsMean = elig.length ? elig.reduce((n, x) => n + x.sends, 0) / elig.length : 0;

	// harm proxy: an identifier from a hidden block reappears in the original session's later assistant text or tool inputs
	for (const { i, call, path: rp, start, end, b } of hiddenAt) {
		const from = laterAt.find((x) => x.i > i)?.off ?? later.length;
		const hits = identifiers(b.text).map((id) => [id, later.indexOf(id, from)] as const).filter(([, at]) => at >= 0);
		const first = Math.min(...hits.map(([, at]) => at));
		// the assistant message holding the first mention; its call count vs the result's
		const chunk = laterAt.findLast((x) => x.off <= first);
		const soon = hits.length > 0 && !!chunk && chunk.call - call <= 3;
		// unique loss: some returning identifier was nowhere in the triaged transcript before it returned
		const uniqueLoss = hits.some(([id, at]) => {
			const j = laterAt.findLast((x) => x.off <= at)!.i;
			const seen = vis.indexOf(id);
			return seen < 0 || seen >= visOff[j]!;
		});
		const recalled = !!rp && reads.some((x) => x.i > i && x.path === rp && x.from <= end && x.to >= start);
		if (hits.length) r.flagged++;
		r.hidden.push({ ...b, matches: hits.map(([id]) => id), soon, recalled, uniqueLoss });
	}

	// tokens: this session's own tokens per context char; price at each call's own recorded rates
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
		r.ctxTokens += inp + cr;
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
const label = (r: SessionResult) => r.label;

export function report(rs: SessionResult[], meta: { date: string; excluded: number; wallS: number; retries: Record<string, number>; interim?: boolean; sweep?: string }) {
	// forked sessions carry their parent's history: the same entry ids in two files
	const ids = rs.map((r) => new Set(r.decisions.map((d) => d.entry)));
	const shared: string[] = [];
	for (let a = 0; a < rs.length; a++)
		for (let b = a + 1; b < rs.length; b++) {
			const n = [...ids[a]!].filter((x) => ids[b]!.has(x)).length;
			if (n) shared.push(`${rs[a]!.label}/${rs[b]!.label} ${n}`);
		}
	const rows = rs.map((r) => [
		label(r), r.calls, r.eligible, r.judged, r.failOpens, p(r.eligibleChars ? r.hiddenChars / r.eligibleChars : 0),
		p(r.savedPctLast), p(r.savedPctMean), k(r.savedInput), k(r.savedCacheRead), r.costOriginal ? usd(r.costSaved) : "n/a", r.stubs, r.flagged, r.cpt.toFixed(2),
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
	const line = (r: SessionResult) => `- ${label(r)}: ${p(r.savedPctMean)} mean, ${p(r.savedPctLast)} at last call, ${r.costOriginal ? usd(r.costSaved) : "no cost recorded"}`;
	const flaggedAll = rs.flatMap((r) => r.hidden);
	const why = (r: SessionResult) => {
		const n = Math.max(1, r.eligible);
		return `| ${label(r)} | ${p(r.savedPctMean)} | ${r.eligible} | ${p(r.errorGated / n)} | ${p(r.skipRatio / n)} | ${p(r.failOpens / n)} | ${p(r.pruned / n)} | ${p(r.evicted / n)} | ${p(r.prunedOutside / n)} | ${r.sendsMean.toFixed(0)} | ${p(r.judgedChars ? r.hiddenChars / r.judgedChars : 0)} |`;
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
- Harm proxy: ${sum((r) => r.flagged)} of ${flaggedAll.length} hidden blocks flagged (an identifier reappears in later assistant text or tool inputs); ${flaggedAll.filter((h) => h.uniqueLoss).length} unique losses (a returning identifier was visible nowhere else). Definitions under the sweep.

Biggest savers (mean/call):
${bySaved.slice(0, 3).map(line).join("\n")}

Smallest savers:
${bySaved.slice(-3).reverse().map(line).join("\n")}

Where eligible results went (share of eligible results; compacted = removed by an original compaction before session end; pruned outside transcript = dropped because the recorded context was smaller than the transcript; sends = mean calls an eligible result stayed in context):

| session | saved mean/call | eligible | error-gated | < 20% ratio | fail-open | pruned | compacted | pruned outside transcript | sends | hide rate (judged) |
|---|---|---|---|---|---|---|---|---|---|---|
${bySaved.map(why).join("\n")}

Sessions are labelled S01…S20 by model-call rank; the label-to-session mapping and the flagged blocks live in the gitignored \`private/\`. Benchmark-run sessions excluded from the ranking: ${meta.excluded}.
${meta.sweep ?? ""}

## Caveats

- No model re-run: every later turn is the original one. A hidden block the model needed would have cost a \`pi_jev_recall\` call (or a different trajectory) that this replay cannot see; the harm proxy is the only signal for that.
- Compaction: the original sessions compacted; both timelines drop entries before \`firstKeptEntryId\` and add the summary. Triage would have shifted when compaction fires; this replay keeps the original compaction points.
- Branches are replayed in write order, not resolved through \`parentId\`.
- Chars per token comes from growth between consecutive uncompacted calls (chars added / recorded tokens added), not from total tokens over total transcript chars as first specified. The total ratio mixed in the system prompt, and the context some sessions pruned without a compaction entry (recorded context shrinks between calls), which inflated savings (one session showed 12.5% mean on a 6% hide rate). When a call's recorded context is smaller than the timeline, the oldest tool results are dropped from both timelines until it fits.
- Cost: sessions whose usage records no cost show n/a and add $0 to the cost totals; token savings are still counted.
- Stub overhead: 155 tokens/call (system-prompt section + recall schema) is subtracted on every call, from cacheRead when the call had any; stub text itself is in the triaged timeline.
- Fail-open results (judge error after 5 attempts, 15 s each) count as untouched.
- Forked sessions: some files replay their parent's history, so the same tool results are counted in both. Shared triaged results by pair: ${shared.join(", ") || "none"}.
- Wall time covers the completed run only; an earlier attempt ran 84 min before it was restarted to add the incremental decision log.
`;
}

export function flaggedReport(rs: SessionResult[], n = 10): string {
	const top = rs.flatMap((r) => r.hidden).filter((h) => h.matches.length).sort((a, b) => b.matches.length - a.matches.length).slice(0, n);
	return `# Flagged hidden blocks (top ${top.length} by identifier overlap)\n\nRaw session text; not for commit.\n\n${top
		.map((h) => `## ${rs.find((r) => h.session === r.path.split("/").slice(-2).join("/"))?.label} ${h.session} ${h.entry} ${h.tool} lines ${h.lines}\n\nWithin 3 calls: ${h.soon}; recalled by later read: ${h.recalled}. Later mentions (${h.matches.length}): ${h.matches.slice(0, 20).map((m) => `\`${m}\``).join(", ")}\n\n\`\`\`\n${h.text}\n\`\`\``)
		.join("\n\n")}\n`;
}

/** Drop-threshold sweep over offline replays (one SessionResult list per threshold). */
export function sweepReport(byT: [number, SessionResult[]][]): string {
	const rows = byT.map(([t, rs]) => {
		const sum = (f: (r: SessionResult) => number) => rs.reduce((a, r) => a + f(r), 0);
		const hidden = rs.flatMap((r) => r.hidden);
		const flagged = hidden.filter((h) => h.matches.length);
		const unique = hidden.filter((h) => h.uniqueLoss);
		return `| ${t.toFixed(2)} | ${p(sum((r) => r.hiddenChars) / Math.max(1, sum((r) => r.judgedChars)))} | ${p(sum((r) => r.savedInput + r.savedCacheRead) / Math.max(1, sum((r) => r.ctxTokens)))} | ${p(quantile(rs.map((r) => r.savedPctMean), 0.5))} | ${hidden.length} | ${flagged.length} (${p(flagged.length / Math.max(1, hidden.length))}) | ${p(flagged.filter((h) => h.soon).length / Math.max(1, flagged.length))} / ${p(flagged.filter((h) => !h.soon).length / Math.max(1, flagged.length))} | ${hidden.filter((h) => h.recalled).length} | ${unique.length} (${p(unique.length / Math.max(1, hidden.length))}) | ${unique.filter((h) => h.recalled).length} | ${p((flagged.length - unique.length) / Math.max(1, flagged.length))} |`;
	});
	return `
## Drop-threshold sweep (offline, same judged probabilities)

First/last block kept, error gate >= 0.5, >= 20% prune ratio. Context saved is net of the 155-token overhead, over all calls' input+cacheRead tokens (aggregate) and the per-session mean/call (p50). Flagged: a hidden block's identifier appears in the original session's later assistant text or tool inputs, split by whether the first mention is within the next 3 model calls. Recalled: a later \`read\` of the same path covers the hidden lines.

Two harm proxies. **Flagged** (loose): at least one identifier from the hidden block appears in the original session's later assistant text or tool inputs. **Unique loss** (strict): at least one of those returning identifiers appears nowhere in the text the model could see at the moment it returns, i.e. not in the result's kept blocks, and not in any earlier tool result, assistant message, user message, custom message or compaction summary in the triaged timeline. Hidden text and stubs are not visible. Identifiers everywhere: 6+ chars after trailing punctuation is stripped, containing a letter plus \`_\`, \`/\`, or camelCase. "Flagged explained by visible text" is the share of flagged blocks that are not unique losses.

| drop <= | judged chars hidden | context saved (aggregate) | context saved (session p50) | hidden blocks | flagged | flagged within 3 calls / later | recalled by later read | unique loss | unique loss re-read later | flagged explained by visible text |
|---|---|---|---|---|---|---|---|---|---|---|
${rows.join("\n")}
`;
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
	const offline = argv.includes("--offline");
	const { picked, excluded } = pickSessions(top);
	console.error(`sessions ${picked.length}; excluded ${excluded.length}; judge ${offline ? "offline" : inner.name}; stateCap ${tcfg.stateCap}; cached ${cached.size}; log ${decisionsPath}`);
	const privDir = join(dir, "private");
	const wallMin = argv.includes("--wall") ? Number(opt("--wall", "0")) : undefined;

	/** Replay the picked sessions 4 at a time; `onDone` sees each finished session. */
	const runAll = async (cfg: TriageConfig, o: ReplayOpts, onDone?: (r: SessionResult, j: number) => void) => {
		const out: SessionResult[] = new Array(picked.length);
		let next = 0;
		await Promise.all(
			Array.from({ length: 4 }, async () => {
				while (next < picked.length) {
					const j = next++;
					const r = await replaySession(picked[j]!.path, ask, cfg, o);
					r.label = `S${String(j + 1).padStart(2, "0")}`;
					out[j] = r;
					onDone?.(r, j);
				}
			}),
		);
		return out;
	};

	/** results md (labels + numbers only), plus the private mapping and flagged blocks. The sweep replays
	 *  `done` offline from the decisions on disk at each drop threshold. */
	const outputs = async (done: SessionResult[], interim: boolean) => {
		const cache = new Map(readDecisions(decisionsPath).map((d) => [`${d.session}|${d.entry}`, d]));
		const byT: [number, SessionResult[]][] = [];
		for (const t of [0.1, 0.15, 0.2, 0.25, 0.3]) {
			const rs: SessionResult[] = [];
			for (const r of done) rs.push(await replaySession(r.path, ask, { ...tcfg, drop: t }, { cached: cache, offline: true }));
			byT.push([t, rs]);
		}
		const wallS = wallMin !== undefined ? wallMin * 60 : (Date.now() - t0) / 1000;
		const md = report(done, { date, excluded: excluded.length, wallS, retries: argv.includes("--retries") ? JSON.parse(opt("--retries", "{}")) : retryCounts, interim, sweep: sweepReport(byT) });
		writeFileSync(join(dir, `results-${date}.md`), md);
		mkdirSync(privDir, { recursive: true });
		writeFileSync(
			join(privDir, `sessions-${date}.md`),
			`# Session labels\n\n${done.map((r) => `- ${r.label}: ${r.cwd} ${r.path}`).join("\n")}\n\nExcluded:\n${excluded.map((s) => `- ${s.cwd} ${s.path} (${s.calls} calls)`).join("\n") || "- none"}\n`,
		);
		writeFileSync(join(privDir, `flagged-${date}.md`), flaggedReport(done));
		return md;
	};

	if (offline) {
		const all = await runAll(tcfg, { cached, offline: true });
		const done = all.filter((r) => !r.missing);
		console.log(await outputs(done, done.length < picked.length));
		process.exit(0);
	}

	let finished = 0;
	const results = await runAll(tcfg, { cached, log }, (r, j) => {
		console.error(`  [${j + 1}/${picked.length}] ${name(r)} calls ${r.calls} judged ${r.judged}/${r.eligible} failopen ${r.failOpens} saved ${p(r.savedPctMean)}`);
		if (++finished === 10 && picked.length > 10) console.error("  10 sessions done; run with --offline for the interim report");
	});
	writeFileSync(decisionsPath, results.flatMap((r) => r.decisions).map((d) => JSON.stringify(d)).join("\n") + "\n");
	console.log(await outputs(results, false));
}

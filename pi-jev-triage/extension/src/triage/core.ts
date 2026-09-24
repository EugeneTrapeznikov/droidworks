// Tool-result triage: split a large tool result into ~25-line blocks, ask the judge one
// batched question set ("is block bK needed?" + one error gate), hide the dead runs behind a
// recall stub. Port of GhalebDweikat/winnow's design onto Pi's `tool_result` event.
//
// Prompt cache: this rewrite happens at ingestion, before the result is ever sent, so it only
// changes the message being appended. Earlier messages are never mutated here and the cached
// prefix stays valid. Never reach back into the transcript from this module.
//
// No pi imports: everything here is plain Node so `bun test` can drive it without the agent.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { record } from "../telemetry.ts";
import { askOrNull, withDeadline } from "../judge/index.ts";
import type { JevConfig, Judge, JudgeResponse, Question } from "../judge/types.ts";
import { type JevSettings, pickNum, readSettings, resolveJudge } from "../settings.ts";
import { detectStructured } from "./structured.ts";

export { detectStructured } from "./structured.ts";

export interface TriageConfig {
	tools: string[];
	minChars: number;
	blockLines: number;
	blockChars: number;
	drop: number;
	keep: number;
	minPruneRatio: number;
	stateCap: number;
	/** Judged blocks per judge request; 0 sends them all in one. */
	maxBlocksPerCall: number;
	cacheDir: string;
	questions: QuestionSet;
	/** Pass unified diffs and JSON bodies through untouched (`detectStructured`). */
	skipStructured: boolean;
}

const num = (v: string | undefined, d: number) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));

/** PI_JEV_* env > settings.json "pi-jev" (`judges.<name>` over `triage` for drop/keep, `stateChars`) > default. */
export function loadTriageConfig(env: NodeJS.ProcessEnv = process.env, s: JevSettings = readSettings(env)): TriageConfig {
	const t = s.triage ?? {};
	const j = resolveJudge(env, s);
	const tools = env.PI_JEV_TRIAGE_TOOLS ?? (Array.isArray(t.tools) ? t.tools.join(",") : "read,bash,grep,find,ls,fetch_url,mcp");
	return {
		tools: tools
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
		minChars: pickNum(env.PI_JEV_TRIAGE_MIN_CHARS, t.minChars, 2000),
		blockLines: pickNum(env.PI_JEV_BLOCK_LINES, t.blockLines, 25),
		blockChars: pickNum(env.PI_JEV_BLOCK_CHARS, t.blockChars, DEFAULT_BLOCK_CHARS),
		drop: pickNum(env.PI_JEV_DROP, j.drop ?? t.drop, 0.2),
		keep: pickNum(env.PI_JEV_KEEP, j.keep ?? t.keep, 0.5),
		minPruneRatio: pickNum(env.PI_JEV_MIN_PRUNE_RATIO, t.minPruneRatio, 0.2),
		stateCap: pickNum(
			env.PI_JEV_STATE_CHARS,
			j.stateChars ?? s.stateChars?.[j.backend],
			STATE_CHARS[j.backend] ?? DEFAULT_STATE_CHARS,
		),
		maxBlocksPerCall: pickNum(env.PI_JEV_MAX_BLOCKS_PER_CALL, j.maxBlocksPerCall, 0),
		cacheDir: env.PI_JEV_CACHE_DIR ?? join(homedir(), ".pi", "agent", "pi-jev", "cache"),
		questions: questionSet(env, s),
		skipStructured:
			env.PI_JEV_SKIP_STRUCTURED !== undefined ? env.PI_JEV_SKIP_STRUCTURED !== "0" : (t.skipStructured ?? true),
	};
}

/** edit/write are never triaged: their results are confirmations the agent must see intact. */
const DENY = new Set(["edit", "write", "pi_jev_recall"]);

/** `mcp` in the allowlist covers `mcp`, `mcp_search`, `mcp__server__tool`. */
export function matchesTool(toolName: string, allow: string[]): boolean {
	if (DENY.has(toolName)) return false;
	return allow.some((a) => toolName === a || toolName.startsWith(`${a}_`));
}

export interface Block {
	id: string;
	start: number;
	end: number;
	text: string;
	/** Set only on a piece of a line longer than `blockChars`: char range [from, to) within line `start`. */
	from?: number;
	to?: number;
}

/** Default cap on characters per block; long-line output (JSON, minified, fetched pages) gets fewer lines per block. */
export const DEFAULT_BLOCK_CHARS = 1500;

/**
 * Split on line boundaries into blocks of at most `blockLines` lines AND at most ~`blockChars` chars.
 * A single line longer than `blockChars` is hard-split into consecutive pieces of ≤ `blockChars`,
 * each recording its char range (`from`/`to`) on that line; `start`/`end` stay the real line, so
 * stubs and recall address whole lines. `firstLine` is the file line number of the first line (read offsets).
 */
export function splitBlocks(text: string, blockLines: number, firstLine = 1, blockChars = DEFAULT_BLOCK_CHARS): Block[] {
	const lines = text.split("\n");
	const blocks: Block[] = [];
	const cap = Math.max(1, blockChars);
	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		if (line.length > cap) {
			for (let from = 0; from < line.length; from += cap) {
				const to = Math.min(line.length, from + cap);
				blocks.push({ id: `b${blocks.length}`, start: firstLine + i, end: firstLine + i, text: line.slice(from, to), from, to });
			}
			i++;
			continue;
		}
		let j = i;
		let chars = 0;
		while (j < lines.length && j - i < blockLines && (j === i || chars + lines[j]!.length + 1 <= cap)) {
			chars += lines[j]!.length + 1;
			j++;
		}
		blocks.push({ id: `b${blocks.length}`, start: firstLine + i, end: firstLine + j - 1, text: lines.slice(i, j).join("\n") });
		i = j;
	}
	return blocks;
}

/** Inverse of `splitBlocks`: pieces of one split line join with no separator, everything else with "\n". */
export function joinBlocks(blocks: Pick<Block, "text" | "from">[]): string {
	return blocks.map((b, i) => (i && !b.from ? "\n" : "") + b.text).join("");
}

/** winnow's task allowance: 1,500 chars of prompt + 1,500 of the latest agent note. */
export const TASK_PROMPT_CHARS = 1500;
export const TASK_NOTE_CHARS = 1500;
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
/** Harness-generated user turns: tag-wrapped notices, interrupt markers, command caveats. */
const MACHINE = /^(<[a-z][\w-]*[\s>]|\[Request interrupted|Caveat: )/i;

/**
 * Most recent substantive prompt in `prompts` (oldest first). Machine text is skipped, and so is
 * anything under 40 chars, which covers fillers like "continue", "go on", "yes", "ok", "next",
 * "do it", "proceed". With nothing substantive, the latest human prompt. First 1,500 chars.
 */
export function pickPrompt(prompts: string[]): string {
	const human = prompts.map((p) => p.replace(REMINDER, "").trim()).filter((p) => p && !MACHINE.test(p));
	const pick = human.findLast((p) => p.length >= 40) ?? human.at(-1) ?? "";
	return pick.slice(0, TASK_PROMPT_CHARS);
}

/** The judge's task text. Shared with bench/session-replay so both send the same string. */
export function formatTask(prompt: string, assistant: string): string {
	const note = assistant.trim().slice(-TASK_NOTE_CHARS);
	return [prompt && `Task: ${prompt.slice(0, TASK_PROMPT_CHARS)}`, note && `Latest agent note: ${note}`]
		.filter(Boolean)
		.join("\n");
}

/** Task context for the judge: the latest substantive user prompt + the tail of the latest assistant text. */
export function taskContext(sessionManager: any): string {
	let entries: any[] = [];
	try {
		entries = sessionManager?.getBranch?.() ?? [];
	} catch {
		return "";
	}
	const prompts: string[] = [];
	let assistant = "";
	for (const e of entries) {
		const m = e?.message;
		if (m?.role === "user") prompts.push(contentText(m.content));
		else if (m?.role === "assistant") assistant = contentText(m.content) || assistant;
	}
	return formatTask(pickPrompt(prompts), assistant);
}

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c: any) => c?.type === "text" && typeof c.text === "string")
		.map((c: any) => c.text)
		.join("\n")
		.trim();
}

/** Judged-state cap per backend when neither `PI_JEV_STATE_CHARS` nor settings `stateChars` is set (README "Judged-state cap per backend"):
 *  jev-1.13 bounds state + longest question at 32k tokens, kev each question at 8,192. */
export const DEFAULT_STATE_CHARS = 80_000;
export const STATE_CHARS: Record<string, number> = { vercel: 80_000, typesafe: 80_000, local: 24_000 };

/**
 * Judge state: task context, tool name, and blocks under their ids, as winnow builds it. Blocks go in
 * full text; the leading blocks are included while they fit in `stateCap - task - tool`, and the
 * first block that does not fit ends the run. The rest stay unjudged (kept verbatim). Callers read
 * `Object.keys(state.blocks)` for the judged set.
 */
export function buildState(task: string, blocks: Block[], stateCap: number, tool = "") {
	const head = task.slice(0, Math.min(3200, Math.floor(stateCap / 4)));
	const name = tool.slice(0, 100);
	let budget = stateCap - head.length - name.length;
	const out: Record<string, string> = {};
	for (const b of blocks) {
		if (b.text.length > budget) break;
		out[b.id] = b.text;
		budget -= b.text.length;
	}
	return { task: head, tool: name, blocks: out };
}

export const ERROR_GATE = "err";

/** Sharpened block-relevance question. The "unrelated" clause matters: bare "is this needed" scores 0.30
 *  on kev-0.8b (says yes to everything), this phrasing 0.75 on the same items. */
export const SHARPENED_BLOCK_QUESTION =
	"Is this block needed to carry out the current task? Answer no if it is from an unrelated file or an unrelated part of the code, or is boilerplate the task does not touch.";

/**
 * winnow v0.5.0 `structured` block question and its shared `ERROR_QUESTION`, verbatim from
 * GhalebDweikat/winnow@0bf46619daee883b278c7f42ee994f963d093321 `sidecar/src/winnow/questions.py`,
 * flattened into one instructions string because our noul has no criteria. `{block}` becomes
 * `blocks.bK` (our state key) or "this block" when the text rides in `subject`. winnow's state also
 * carries `tool`; ours does not.
 */
export const WINNOW_BLOCK_QUESTION = `Would the assistant have to look at {block} to accomplish \`task\` correctly? Judge only this block, against \`task\` and \`tool\`.

Answer yes when: The assistant must read this text to do the task right.
Examples:
- the function, class, or setting the user asked to change
- the failing test, the assertion, and the traceback
- the search hit for the symbol in question
- the value or record the task must report or compare

Answer no when: The task can be completed correctly without ever reading this block.
Do not mark a block needed only because it comes from the same file or the same command as something that is needed.
Examples:
- license headers, imports, and module docstrings
- functions and settings unrelated to the request
- repeated success lines in a build or test log
- listings of items the task does not mention`;

export const WINNOW_ERROR_QUESTION = `Does the tool output (the whole of \`blocks\`) show an error, failure, warning, or unexpected result that the assistant needs to know about?

Answer yes when: Tracebacks, non-zero exits, 'not found', permission errors, failing tests, or output that contradicts what \`task\` expected.
Answer no when: Ordinary successful output.`;

export const SHARPENED_ERROR_QUESTION = "Does this output contain an error, failure, or warning the agent must see?";

/** `block(id)` addresses a block in `state.blocks`; `block()` is the form for a subject-carried block. */
export interface QuestionSet {
	block: (id?: string) => string;
	error: string;
}

export const QUESTION_SETS = {
	sharpened: {
		block: (id?: string) => (id ? SHARPENED_BLOCK_QUESTION.replace("this block", `block ${id}`) : SHARPENED_BLOCK_QUESTION),
		error: SHARPENED_ERROR_QUESTION,
	},
	winnow: {
		block: (id?: string) => WINNOW_BLOCK_QUESTION.replace("{block}", id ? `\`blocks.${id}\`` : "this block"),
		error: WINNOW_ERROR_QUESTION,
	},
} satisfies Record<string, QuestionSet>;

/** The default set's block question in its subject-carried form. */
export const BLOCK_QUESTION = QUESTION_SETS.winnow.block();

/** `PI_JEV_QUESTION_SET` > settings `questionSet` > `winnow`. An unknown name throws so a typo cannot silently fall back. */
export function questionSet(env: NodeJS.ProcessEnv = process.env, s: JevSettings = readSettings(env)): QuestionSet {
	const name = env.PI_JEV_QUESTION_SET || s.questionSet || "winnow";
	const set = (QUESTION_SETS as Record<string, QuestionSet>)[name];
	if (!set) throw new Error(`PI_JEV_QUESTION_SET=${name}: expected one of ${Object.keys(QUESTION_SETS).join(", ")}`);
	return set;
}

export const blockQuestion = (id: string, set: QuestionSet = questionSet()) => set.block(id);

export function buildQuestions(blocks: Block[], set: QuestionSet = questionSet()): Record<string, Question> {
	const q: Record<string, Question> = { [ERROR_GATE]: { type: "noul", instructions: set.error } };
	for (const b of blocks) q[b.id] = { type: "noul", instructions: set.block(b.id) };
	return q;
}

/**
 * Ask about `judged` in consecutive chunks of <= `max` blocks (0 = one request), one after another.
 * Each chunk carries the same task/tool, only its own blocks, and the error question. Answers merge
 * by block id; the error answer is the highest over chunks. The chunks share one `timeoutMs` budget,
 * and any failed chunk returns null so the caller fails open: never a partial rewrite.
 */
export async function askChunked(
	judge: Judge,
	state: ReturnType<typeof buildState>,
	judged: Block[],
	set: QuestionSet,
	max: number,
	timeoutMs: number,
): Promise<JudgeResponse | null> {
	const size = max > 0 ? max : judged.length;
	const deadline = Date.now() + timeoutMs;
	const out: JudgeResponse = { answers: {}, latencyMs: 0, backend: judge.name };
	let err = 0;
	let tokens: number | undefined;
	for (let i = 0; i < judged.length; i += size) {
		const chunk = judged.slice(i, i + size);
		const left = deadline - Date.now();
		if (left <= 0) return null;
		const blocks = Object.fromEntries(chunk.map((b) => [b.id, state.blocks[b.id]!]));
		const res = await askOrNull(judge, { state: { ...state, blocks }, questions: buildQuestions(chunk, set), timeoutMs: left });
		if (!res) return null;
		Object.assign(out.answers, res.answers);
		err = Math.max(err, prob(res.answers?.[ERROR_GATE]));
		out.latencyMs += res.latencyMs ?? 0;
		if (res.usage) tokens = (tokens ?? 0) + res.usage.inputTokens;
	}
	out.answers[ERROR_GATE] = { type: "noul", probability: err };
	if (tokens !== undefined) out.usage = { inputTokens: tokens };
	return out;
}

export interface Decision {
	hidden: boolean[];
	dropped: number;
	kept: number;
	uncertain: number;
	hiddenChars: number;
	errorGate: boolean;
}

/**
 * Drop at P <= drop, keep verbatim at P >= keep, uncertain stays verbatim.
 * The first and last block are always kept (head/tail context).
 * Error gate at P >= 0.5 keeps everything.
 */
export function decide(blocks: Block[], probs: Record<string, number>, errProb: number, cfg: TriageConfig): Decision {
	const errorGate = errProb >= 0.5;
	const last = blocks.length - 1;
	const hidden = blocks.map((b, i) => {
		if (errorGate || i === 0 || i === last) return false;
		return (probs[b.id] ?? 1) <= cfg.drop;
	});
	let uncertain = 0;
	blocks.forEach((b, i) => {
		const p = probs[b.id] ?? 1;
		if (!hidden[i] && p > cfg.drop && p < cfg.keep) uncertain++;
	});
	const dropped = hidden.filter(Boolean).length;
	return {
		hidden,
		dropped,
		kept: blocks.length - dropped,
		uncertain,
		hiddenChars: blocks.reduce((n, b, i) => n + (hidden[i] ? b.text.length : 0), 0),
		errorGate,
	};
}

export function stub(key: string, start: number, end: number, lines: number, chars: number): string {
	return `[pi-jev: hid lines ${start}–${end} (${lines} lines, ${chars} chars).\n Restore: pi_jev_recall(key="${key}", start=${start}, end=${end})]`;
}

/** Replace each run of hidden blocks with one stub; keep everything else verbatim. A stub always
 *  sits on its own line; visible pieces of one split line rejoin with no separator. */
export function rewrite(blocks: Block[], hidden: boolean[], key: string): string {
	let out = "";
	let prevStub = false;
	for (let i = 0; i < blocks.length; i++) {
		const sep = i === 0 ? "" : prevStub || !blocks[i]!.from ? "\n" : "";
		if (!hidden[i]) {
			out += sep + blocks[i]!.text;
			prevStub = false;
			continue;
		}
		let j = i;
		let chars = 0;
		while (j < blocks.length && hidden[j]) chars += blocks[j++]!.text.length;
		const start = blocks[i]!.start;
		const end = blocks[j - 1]!.end;
		out += (i === 0 ? "" : "\n") + stub(key, start, end, end - start + 1, chars);
		prevStub = true;
		i = j - 1;
	}
	return out;
}

export const cacheKey = (toolCallId: string, content: string) =>
	createHash("sha1").update(`${toolCallId}\u0000${content}`).digest("hex");

export function writeCache(dir: string, key: string, text: string, firstLine: number): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${key}.txt`), text);
	writeFileSync(join(dir, `${key}.json`), JSON.stringify({ firstLine }));
}

/** System-prompt section key and text telling the model how to read stubs. Constant, so the cached
 *  prompt prefix is identical every turn. */
export const RECALL_SECTION = "pi-jev";
export const RECALL_NOTE = [
	"Some large tool results are shortened. Hidden ranges appear as `[pi-jev: hid lines A–B …]` stubs.",
	"To read a range back, call `pi_jev_recall(key, start, end)` with the key and lines from the stub; do not re-run the tool.",
	"The first and last blocks of a result are always shown.",
].join("\n");

/** `before_agent_start`: set the section in place. Never return `{ systemPrompt }`: a forced prompt
 *  replaces the structured sections and rewrites the cache prefix every turn. */
export function addRecallNote(event: { systemPromptOptions?: { sections?: Record<string, string> } }): void {
	const sections = event.systemPromptOptions?.sections;
	if (sections) sections[RECALL_SECTION] = RECALL_NOTE;
}

/** Inclusive line range, numbered the same way the stub numbers them. */
export function readCache(dir: string, key: string, start: number, end: number): string {
	const text = readFileSync(join(dir, `${key}.txt`), "utf-8");
	let firstLine = 1;
	try {
		firstLine = JSON.parse(readFileSync(join(dir, `${key}.json`), "utf-8")).firstLine ?? 1;
	} catch {
		// no sidecar: assume the output was numbered from line 1
	}
	const lines = text.split("\n");
	const from = Math.max(0, start - firstLine);
	const to = Math.min(lines.length, end - firstLine + 1);
	if (from >= to) throw new Error(`No cached lines ${start}-${end} for key ${key}`);
	return lines.slice(from, to).join("\n");
}

/** P(yes) of a noul answer; a missing or malformed answer reads as 1 (keep; error gate fires). */
export const prob = (a: any): number => (a && a.type === "noul" && typeof a.probability === "number" ? a.probability : 1);

export interface TriageEvent {
	toolName: string;
	toolCallId: string;
	input?: Record<string, unknown>;
	content: any[];
	isError?: boolean;
}

/**
 * The `tool_result` handler. Returns `{ content }` to replace the result, or `undefined` to
 * leave it untouched (shadow mode, any skip, and every judge failure).
 */
export function makeHandler(judge: Judge, cfg: JevConfig, tcfg: TriageConfig = loadTriageConfig()) {
	return async function triageToolResult(event: TriageEvent, ctx: any): Promise<{ content: any[] } | undefined> {
		if (event.isError) return;
		if (!matchesTool(event.toolName, tcfg.tools)) return;

		// One judge call per tool result: triage the largest text part, leave images and the rest.
		let idx = -1;
		for (let i = 0; i < (event.content?.length ?? 0); i++) {
			const c = event.content[i];
			if (c?.type !== "text" || typeof c.text !== "string") continue;
			if (idx < 0 || c.text.length > event.content[idx].text.length) idx = i;
		}
		if (idx < 0) return;
		const text: string = event.content[idx].text;
		if (text.length < tcfg.minChars) return;

		const kind = tcfg.skipStructured ? detectStructured(text) : null;
		if (kind) {
			// a stub inside a diff or JSON body breaks the whole unit; never ask the judge
			return void record(cfg, {
				feature: "triage",
				backend: judge.name,
				latencyMs: 0,
				detail: {
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					bytesBefore: text.length,
					bytesAfter: text.length,
					outcome: "skip_structured",
					structured: kind,
				},
			});
		}

		const firstLine = event.toolName === "read" ? num(String(event.input?.offset ?? ""), 1) : 1;
		const blocks = splitBlocks(text, tcfg.blockLines, firstLine, tcfg.blockChars);
		if (blocks.length < 3) return; // fewer than 3 lines: head + tail protection leaves nothing hideable

		const state = buildState(taskContext(ctx?.sessionManager), blocks, tcfg.stateCap, event.toolName);
		// Blocks past the state cap are not asked about; decide() keeps them (missing answer = P 1).
		const judged = blocks.filter((b) => b.id in state.blocks);
		if (!judged.length) return;

		const base = {
			feature: "triage" as const,
			backend: judge.name,
			detail: {
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				blocks: blocks.length,
				judged: judged.length,
				bytesBefore: text.length,
			},
		};
		const started = Date.now();
		// askChunked never throws; withDeadline covers a backend that ignores its own timeout.
		const res: JudgeResponse | null = await withDeadline(
			askChunked(judge, state, judged, tcfg.questions, tcfg.maxBlocksPerCall, cfg.timeoutMs),
			cfg.timeoutMs,
			"triage",
		).catch(() => null);
		if (!res) {
			// fail open: the agent sees the full result
			record(cfg, {
				...base,
				latencyMs: Date.now() - started,
				detail: { ...base.detail, bytesAfter: text.length, outcome: "failopen" },
			});
			return;
		}

		const probs: Record<string, number> = {};
		for (const b of blocks) probs[b.id] = prob(res.answers?.[b.id]);
		const errProb = prob(res.answers?.[ERROR_GATE]);
		const d = decide(blocks, probs, errProb, tcfg);
		const log = (outcome: string, bytesAfter: number) =>
			record(cfg, {
				...base,
				latencyMs: res.latencyMs ?? Date.now() - started,
				inputTokens: res.usage?.inputTokens,
				detail: {
					...base.detail,
					dropped: d.dropped,
					kept: d.kept,
					uncertain: d.uncertain,
					bytesAfter,
					errorGate: d.errorGate,
					outcome,
					probabilities: { ...probs, [ERROR_GATE]: errProb },
				},
			});

		if (d.errorGate) return void log("errorgate", text.length);
		if (d.hiddenChars / text.length < tcfg.minPruneRatio) return void log("skip_ratio", text.length);

		const key = cacheKey(event.toolCallId, text);
		const pruned = rewrite(blocks, d.hidden, key);
		log("pruned", pruned.length);
		if (cfg.shadow) return; // decided and logged, result untouched
		try {
			writeCache(tcfg.cacheDir, key, text, firstLine);
		} catch {
			return; // never hide text we could not cache: recall would have nothing to restore
		}
		const content = event.content.slice();
		content[idx] = { ...content[idx], text: pruned };
		return { content };
	};
}

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JevConfig, Judge, JudgeRequest, JudgeResponse } from "../src/judge/types.ts";
import {
	BLOCK_QUESTION,
	buildQuestions,
	buildState,
	cacheKey,
	decide,
	ERROR_GATE,
	loadTriageConfig,
	makeHandler,
	matchesTool,
	QUESTION_SETS,
	questionSet,
	readCache,
	rewrite,
	splitBlocks,
	stub,
	taskContext,
	writeCache,
	type TriageConfig,
} from "../src/triage/core.ts";

const tcfg = (over: Partial<TriageConfig> = {}): TriageConfig => ({
	...loadTriageConfig({} as NodeJS.ProcessEnv, {}),
	cacheDir: mkdtempSync(join(tmpdir(), "pi-jev-")),
	...over,
});

const cfg = (over: Partial<JevConfig> = {}): JevConfig => ({
	judge: "mock",
	shadow: false,
	features: new Set(["triage"]) as JevConfig["features"],
	logPath: join(mkdtempSync(join(tmpdir(), "pi-jev-log-")), "decisions.jsonl"),
	timeoutMs: 750,
	...over,
});

/** Inline mock judge: the backends are written by a sibling; we only consume the contract. */
function mockJudge(answer: (id: string, req: JudgeRequest) => number, name = "mock"): Judge {
	return {
		name,
		async ask(req: JudgeRequest): Promise<JudgeResponse> {
			const answers: JudgeResponse["answers"] = {};
			for (const id of Object.keys(req.questions)) answers[id] = { type: "noul", probability: answer(id, req) };
			return { answers, latencyMs: 3, backend: name, usage: { inputTokens: 42 } };
		},
	};
}

const lines = (n: number, w = 40) => Array.from({ length: n }, (_, i) => `line${i + 1} `.padEnd(w, "x")).join("\n");

const ev = (text: string, over: Record<string, unknown> = {}) => ({
	toolName: "read",
	toolCallId: "call_1",
	input: {},
	content: [{ type: "text", text }],
	isError: false,
	...over,
});

const ctxStub = { sessionManager: { getBranch: () => [] } };

const readLog = (c: JevConfig) =>
	readFileSync(c.logPath!, "utf-8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));

describe("block splitting", () => {
	test("aligns to line boundaries and is lossless", () => {
		const text = lines(60);
		const blocks = splitBlocks(text, 25);
		expect(blocks.map((b) => b.id)).toEqual(["b0", "b1", "b2"]);
		expect(blocks.map((b) => [b.start, b.end])).toEqual([
			[1, 25],
			[26, 50],
			[51, 60],
		]);
		expect(blocks.map((b) => b.text).join("\n")).toBe(text);
	});

	test("read offsets become file line numbers", () => {
		const blocks = splitBlocks(lines(30), 25, 101);
		expect(blocks.map((b) => [b.start, b.end])).toEqual([
			[101, 125],
			[126, 130],
		]);
	});

	test("tool allowlist covers mcp prefixes and never edit/write", () => {
		const allow = loadTriageConfig({} as NodeJS.ProcessEnv, {}).tools;
		expect(matchesTool("read", allow)).toBe(true);
		expect(matchesTool("mcp__github__list_prs", allow)).toBe(true);
		expect(matchesTool("edit", allow)).toBe(false);
		expect(matchesTool("write", allow)).toBe(false);
		expect(matchesTool("subagent", allow)).toBe(false);
	});
});

describe("thresholds", () => {
	const blocks = splitBlocks(lines(125), 25); // 5 blocks

	test("drops at or below PI_JEV_DROP, keeps above", () => {
		const d = decide(blocks, { b0: 0.9, b1: 0.05, b2: 0.1, b3: 0.11, b4: 0.9 }, 0, tcfg());
		expect(d.hidden).toEqual([false, true, true, false, false]);
		expect(d.dropped).toBe(2);
		expect(d.kept).toBe(3);
	});

	test("uncertain blocks stay verbatim and are counted", () => {
		const d = decide(blocks, { b0: 0.9, b1: 0.3, b2: 0.49, b3: 0.5, b4: 0.9 }, 0, tcfg());
		expect(d.hidden).toEqual([false, false, false, false, false]);
		expect(d.uncertain).toBe(2);
	});

	test("head and tail are never touched", () => {
		const d = decide(blocks, { b0: 0, b1: 0, b2: 0, b3: 0, b4: 0 }, 0, tcfg());
		expect(d.hidden).toEqual([false, true, true, true, false]);
	});

	test("error gate at P >= 0.5 keeps everything", () => {
		const d = decide(blocks, { b0: 0, b1: 0, b2: 0, b3: 0, b4: 0 }, 0.5, tcfg());
		expect(d.errorGate).toBe(true);
		expect(d.hidden.some(Boolean)).toBe(false);
	});
});

describe("judge request shape", () => {
	test("one noul per block plus the error gate, state capped", () => {
		const blocks = splitBlocks(lines(500), 25);
		const q = buildQuestions(blocks);
		expect(Object.keys(q).length).toBe(blocks.length + 1);
		expect(q[ERROR_GATE]!.type).toBe("noul");
		expect((q.b3 as any).instructions).toContain("b3");
		const state = buildState("do the thing", blocks, 24000, "read");
		expect(JSON.stringify(state).length).toBeLessThan(26000);
		expect(Object.keys(state.blocks).length).toBe(blocks.length);
		expect(state.tool).toBe("read");
	});

	test("state never exceeds the cap; only a leading run of full blocks is sent", () => {
		const size = (s: ReturnType<typeof buildState>) => s.task.length + s.tool.length + Object.values(s.blocks).join("").length;
		const blocks = splitBlocks(lines(5000, 60), 25); // 200 blocks, 305k chars
		for (const cap of [24000, 12000, 1000]) {
			const s = buildState("t".repeat(3000), blocks, cap, "bash");
			expect(size(s)).toBeLessThanOrEqual(cap);
			expect(s.task.length).toBeLessThanOrEqual(3200);
			const ids = Object.keys(s.blocks);
			expect(ids).toEqual(blocks.slice(0, ids.length).map((b) => b.id)); // a leading run
			for (const b of blocks.slice(0, ids.length)) expect(s.blocks[b.id]).toBe(b.text); // never truncated
			// the next block is exactly the one that would overflow
			if (ids.length < blocks.length) expect(size(s) + blocks[ids.length]!.text.length).toBeGreaterThan(cap);
		}
		// an oversized first block ends the run: nothing is judged, nothing is cut
		expect(Object.keys(buildState("", [{ id: "b0", start: 1, end: 1, text: "x".repeat(50) }, blocks[0]!], 40).blocks)).toEqual([]);
	});

	test("per-backend state cap default; PI_JEV_STATE_CHARS overrides", () => {
		const cap = (env: Record<string, string>) => loadTriageConfig(env as NodeJS.ProcessEnv, {}).stateCap;
		expect(cap({})).toBe(80_000);
		expect(cap({ PI_JEV_JUDGE: "typesafe" })).toBe(80_000);
		expect(cap({ PI_JEV_JUDGE: "local" })).toBe(24_000);
		expect(cap({ PI_JEV_JUDGE: "local", PI_JEV_STATE_CHARS: "12000" })).toBe(12_000);
	});

	test("handler asks only the judged prefix and keeps unjudged blocks verbatim", async () => {
		const asked: string[] = [];
		const judge = mockJudge((id) => (asked.push(id), id === ERROR_GATE ? 0 : 0));
		const text = lines(2000, 60); // 80 blocks
		const out = await makeHandler(judge, cfg(), tcfg({ stateCap: 60_000 }))(ev(text), ctxStub);
		const judged = asked.filter((id) => id !== ERROR_GATE);
		expect(judged.length).toBeGreaterThan(20);
		expect(judged.length).toBeLessThan(80);
		expect(judged).not.toContain("b79");
		expect(out!.content[0].text).toContain(text.split("\n").slice(-25).join("\n")); // tail unjudged, kept
	});

	const branch = (...m: [string, string][]) => ({
		getBranch: () => m.map(([role, text]) => ({ message: { role, content: role === "user" ? text : [{ type: "text", text }] } })),
	});
	const REAL = "find the bug in parser.ts where nested brackets are dropped";

	test("task context: filler prompts skipped, substantive prompt found, assistant tail included", () => {
		const t = taskContext(
			branch(["user", "an older substantive request about something else entirely"], ["user", REAL], ["assistant", "Looking now. Reading parser.ts."], ["user", "continue"], ["user", "ok"]),
		);
		expect(t).toBe(`Task: ${REAL}\nLatest agent note: Looking now. Reading parser.ts.`);
	});

	test("task context skips machine text and strips system reminders", () => {
		const t = taskContext(
			branch(
				["user", `${REAL}<system-reminder>long harness note here that is not the task</system-reminder>`],
				["user", "<task-notification>agent a1 completed with a long machine-generated status</task-notification>"],
				["user", "[Request interrupted by user for tool use] and some more generated words"],
			),
		);
		expect(t).toBe(`Task: ${REAL}`);
	});

	test("task context falls back to the latest human prompt when none is substantive", () => {
		expect(taskContext(branch(["user", "fix it"], ["user", "go on"]))).toBe("Task: go on");
	});

	test("task caps: first 1,500 prompt chars, last 1,500 assistant chars, 3,200 in state", () => {
		const t = taskContext(branch(["user", "P".repeat(1400) + "Q".repeat(600)], ["assistant", "A".repeat(600) + "B".repeat(1400)]));
		expect(t).toBe(`Task: ${"P".repeat(1400)}${"Q".repeat(100)}\nLatest agent note: ${"A".repeat(100)}${"B".repeat(1400)}`);
		expect(buildState(t, [], 80_000).task).toBe(t);
		expect(buildState("x".repeat(5000), [], 80_000).task.length).toBe(3200);
	});
});

describe("stub and recall", () => {
	test("stub is two lines and names the range", () => {
		const s = stub("abc123", 26, 75, 50, 2311);
		expect(s.split("\n").length).toBe(2);
		expect(s).toContain("hid lines 26–75 (50 lines, 2311 chars)");
		expect(s).toContain('pi_jev_recall(key="abc123", start=26, end=75)');
	});

	test("rewrite collapses a run of dropped blocks into one stub", () => {
		const blocks = splitBlocks(lines(125), 25);
		const out = rewrite(blocks, [false, true, true, false, false], "k");
		expect(out.split("\n").filter((l) => l.includes("pi-jev: hid")).length).toBe(1);
		expect(out).toContain("hid lines 26–75");
		expect(out).toContain("line1 ");
		expect(out).toContain("line101 ");
		expect(out).not.toContain("line40 ");
	});

	test("cache round-trip returns the exact hidden range", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-jev-cache-"));
		const text = lines(125);
		const key = cacheKey("call_1", text);
		writeCache(dir, key, text, 1);
		expect(readCache(dir, key, 26, 75).split("\n")).toEqual(text.split("\n").slice(25, 75));
		// read with offset: stub numbers are file lines, recall maps them back
		writeCache(dir, key, text, 101);
		expect(readCache(dir, key, 126, 130).split("\n")).toEqual(text.split("\n").slice(25, 30));
		expect(() => readCache(dir, key, 9000, 9001)).toThrow();
	});

	test("handler round-trip: pruned output restores to the original", async () => {
		const t = tcfg();
		const c = cfg();
		const text = lines(125);
		const out = await makeHandler(
			mockJudge((id) => (id === ERROR_GATE ? 0 : ["b1", "b2", "b3"].includes(id) ? 0 : 0.9)),
			c,
			t,
		)(ev(text), ctxStub);
		const pruned = out!.content[0].text as string;
		const m = /key="([0-9a-f]+)", start=(\d+), end=(\d+)/.exec(pruned)!;
		expect(readCache(t.cacheDir, m[1]!, Number(m[2]), Number(m[3]))).toBe(text.split("\n").slice(25, 100).join("\n"));
	});
});

describe("handler gates", () => {
	const dropAll = mockJudge((id) => (id === ERROR_GATE ? 0 : 0));

	test("skips results under PI_JEV_TRIAGE_MIN_CHARS", async () => {
		const c = cfg();
		expect(await makeHandler(dropAll, c, tcfg())(ev(lines(10, 10)), ctxStub)).toBeUndefined();
		expect(() => readFileSync(c.logPath!)).toThrow(); // nothing even logged
	});

	test("skips edit and write", async () => {
		const t = ev(lines(125), { toolName: "edit" });
		expect(await makeHandler(dropAll, cfg(), tcfg())(t, ctxStub)).toBeUndefined();
	});

	test("min-prune-ratio skip leaves the result alone", async () => {
		const c = cfg();
		// 10 blocks, only b1 droppable -> ~10% hidden, below the 0.2 ratio
		const judge = mockJudge((id) => (id === "b1" ? 0 : id === ERROR_GATE ? 0 : 0.9));
		expect(await makeHandler(judge, c, tcfg())(ev(lines(250)), ctxStub)).toBeUndefined();
		expect(readLog(c)[0].detail.outcome).toBe("skip_ratio");
	});

	test("error gate keeps everything and is logged", async () => {
		const c = cfg();
		const judge = mockJudge((id) => (id === ERROR_GATE ? 0.9 : 0));
		expect(await makeHandler(judge, c, tcfg())(ev(lines(125)), ctxStub)).toBeUndefined();
		const rec = readLog(c)[0];
		expect(rec.detail.outcome).toBe("errorgate");
		expect(rec.detail.errorGate).toBe(true);
		expect(rec.detail.bytesAfter).toBe(rec.detail.bytesBefore);
	});

	test("the error gate is the judge's answer only: a traceback in the text does not gate", async () => {
		const c = cfg();
		const text = "Traceback (most recent call last):\nValueError: boom\n" + lines(125);
		expect(await makeHandler(dropAll, c, tcfg())(ev(text), ctxStub)).toBeDefined();
		expect(readLog(c)[0].detail.outcome).toBe("pruned");
	});

	test("isError results are never triaged", async () => {
		expect(await makeHandler(dropAll, cfg(), tcfg())(ev(lines(125), { isError: true }), ctxStub)).toBeUndefined();
	});
});

describe("fail-open", () => {
	const throwing: Judge = {
		name: "boom",
		async ask() {
			throw new Error("backend exploded");
		},
	};
	const hanging: Judge = {
		name: "slow",
		ask: () => new Promise(() => {}),
	};

	test("judge throw passes the result through untouched", async () => {
		const c = cfg();
		expect(await makeHandler(throwing, c, tcfg())(ev(lines(125)), ctxStub)).toBeUndefined();
		expect(readLog(c)[0].detail.outcome).toBe("failopen");
	});

	test("judge timeout passes the result through untouched", async () => {
		const c = cfg({ timeoutMs: 20 });
		const t0 = Date.now();
		expect(await makeHandler(hanging, c, tcfg())(ev(lines(125)), ctxStub)).toBeUndefined();
		expect(Date.now() - t0).toBeLessThan(1000);
		const rec = readLog(c)[0];
		expect(rec.detail.outcome).toBe("failopen");
		expect(rec.detail.bytesAfter).toBe(rec.detail.bytesBefore);
	});
});

describe("shadow vs active", () => {
	const judge = mockJudge((id) => (id === ERROR_GATE ? 0 : ["b1", "b2", "b3"].includes(id) ? 0 : 0.9));
	const text = lines(125);

	test("shadow decides, logs, and returns nothing", async () => {
		const c = cfg({ shadow: true });
		const t = tcfg();
		expect(await makeHandler(judge, c, t)(ev(text), ctxStub)).toBeUndefined();
		const rec = readLog(c)[0];
		expect(rec.shadow).toBe(true);
		expect(rec.detail.outcome).toBe("pruned");
		expect(rec.detail.dropped).toBe(3);
		expect(rec.detail.bytesAfter).toBeLessThan(rec.detail.bytesBefore);
		expect(rec.detail.probabilities.b1).toBe(0);
		expect(rec.inputTokens).toBe(42);
	});

	test("active replaces the content", async () => {
		const c = cfg({ shadow: false });
		const out = await makeHandler(judge, c, tcfg())(ev(text), ctxStub);
		expect(out!.content[0].text.length).toBeLessThan(text.length);
		expect(out!.content[0].text).toContain("pi-jev: hid lines 26–100");
		expect(readLog(c)[0].shadow).toBe(false);
	});

	test("non-text content is preserved", async () => {
		const image = { type: "image", data: "…" };
		const out = await makeHandler(judge, cfg(), tcfg())(ev(text, { content: [image, { type: "text", text }] }), ctxStub);
		expect(out!.content[0]).toBe(image);
		expect(out!.content[1].text).toContain("pi-jev: hid");
	});
});

import { joinBlocks, splitBlocks as splitBlocksChars } from "../src/triage/core.ts";
describe("splitBlocks char cap", () => {
  test("long lines produce more, smaller blocks with intact line ranges", () => {
    const text = Array.from({ length: 30 }, (_, i) => `line${i} ` + "x".repeat(400)).join("\n");
    const blocks = splitBlocksChars(text, 25, 1, 1500);
    expect(blocks.length).toBeGreaterThan(3);
    for (const b of blocks) expect(b.text.length).toBeLessThanOrEqual(1500 + 401);
    expect(blocks[0].start).toBe(1);
    expect(blocks[blocks.length - 1].end).toBe(30);
    expect(blocks.map((b) => b.text).join("\n")).toBe(text);
  });
  test("a 40k-char single line is hard-split into ≤ blockChars pieces that recall as the whole line", () => {
    const long = Array.from({ length: 4000 }, (_, i) => `k${i % 10}xxxxxxxx`).join(""); // 40,000 chars
    const text = "head\n" + long + "\ntail";
    const blocks = splitBlocksChars(text, 25, 10, 1500);
    const pieces = blocks.filter((b) => b.from !== undefined);
    expect(pieces.length).toBe(Math.ceil(40_000 / 1500)); // 27
    for (const b of blocks) expect(b.text.length).toBeLessThanOrEqual(1500);
    for (const b of pieces) expect([b.start, b.end]).toEqual([11, 11]);
    expect(pieces.map((b) => [b.from, b.to])).toEqual(pieces.map((_, i) => [i * 1500, Math.min(40_000, (i + 1) * 1500)]));
    expect(joinBlocks(blocks)).toBe(text);

    // hide pieces 2..25 of the line: one stub on its own line, visible pieces rejoin intact
    const hidden = blocks.map((b, i) => i >= 2 && i <= 25);
    const out = rewrite(blocks, hidden, "k");
    expect(out.startsWith(`head\n${long.slice(0, 1500)}\n[pi-jev: hid lines 11–11`)).toBe(true);
    expect(out.endsWith(`]\n${long.slice(25 * 1500)}\ntail`)).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "pi-jev-long-"));
    writeCache(dir, "k", text, 10);
    expect(readCache(dir, "k", 11, 11)).toBe(long);
  });
});

describe("question sets", () => {
	test("default is winnow; env selects sharpened; unknown throws", () => {
		expect(questionSet({} as NodeJS.ProcessEnv, {})).toBe(QUESTION_SETS.winnow);
		expect(QUESTION_SETS.winnow.block()).toBe(BLOCK_QUESTION);
		expect(questionSet({ PI_JEV_QUESTION_SET: "sharpened" } as NodeJS.ProcessEnv, {})).toBe(QUESTION_SETS.sharpened);
		expect(QUESTION_SETS.sharpened.block("b2")).toStartWith("Is block b2 needed");
		expect(() => questionSet({ PI_JEV_QUESTION_SET: "nope" } as NodeJS.ProcessEnv, {})).toThrow();
	});

	test("winnow set addresses blocks.bK, carries not_for, and drives buildQuestions", () => {
		const blocks = splitBlocks(lines(100), 25);
		const q = buildQuestions(blocks, loadTriageConfig({ PI_JEV_QUESTION_SET: "winnow" } as NodeJS.ProcessEnv, {}).questions);
		const b1 = (q.b1 as any).instructions as string;
		expect(b1).toContain("`blocks.b1`");
		expect(b1).toContain("Do not mark a block needed only because it comes from the same file or the same command");
		expect((q[ERROR_GATE] as any).instructions).toContain("Ordinary successful output.");
		expect(QUESTION_SETS.winnow.block()).toStartWith("Would the assistant have to look at this block");
	});
});

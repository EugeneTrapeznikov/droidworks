import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JevConfig, Judge, JudgeRequest } from "../src/judge/types.ts";
import { ERROR_GATE, loadTriageConfig, makeHandler, type TriageConfig } from "../src/triage/core.ts";

const cfg = (over: Partial<JevConfig> = {}): JevConfig => ({
	judge: "mock",
	shadow: false,
	features: new Set(["triage"]) as JevConfig["features"],
	logPath: join(mkdtempSync(join(tmpdir(), "pi-jev-log-")), "decisions.jsonl"),
	timeoutMs: 750,
	...over,
});
const tcfg = (over: Partial<TriageConfig> = {}): TriageConfig => ({
	...loadTriageConfig({} as NodeJS.ProcessEnv, {}),
	cacheDir: mkdtempSync(join(tmpdir(), "pi-jev-")),
	...over,
});
const log = (c: JevConfig) => readFileSync(c.logPath!, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
const ctx = { sessionManager: { getBranch: () => [{ message: { role: "user", content: "fix the bug" } }] } };
// 19 blocks of 25 lines each
const text = Array.from({ length: 19 * 25 }, (_, i) => `line${i + 1} `.padEnd(40, "x")).join("\n");
const ev = { toolName: "read", toolCallId: "c1", input: {}, content: [{ type: "text", text }] };

/** Records every request; `p(id)` answers each question, `delayMs` per request. */
function recJudge(p: (id: string) => number, delayMs = 0) {
	const reqs: JudgeRequest[] = [];
	const judge: Judge = {
		name: "mock",
		async ask(req) {
			reqs.push(req);
			if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
			const answers: Record<string, any> = {};
			for (const id of Object.keys(req.questions)) answers[id] = { type: "noul", probability: p(id) };
			return { answers, latencyMs: 1, backend: "mock", usage: { inputTokens: 10 } };
		},
	};
	return { judge, reqs };
}

describe("maxBlocksPerCall chunking", () => {
	test("19 blocks at 8 per call: 3 requests of 8/8/3, error question and task/tool in each", async () => {
		const { judge, reqs } = recJudge((id) => (id === ERROR_GATE ? 0 : 0.9));
		await makeHandler(judge, cfg(), tcfg({ maxBlocksPerCall: 8 }))(ev, ctx);
		expect(reqs.map((r) => Object.keys(r.questions).filter((k) => k !== ERROR_GATE).length)).toEqual([8, 8, 3]);
		for (const r of reqs) {
			expect(r.questions[ERROR_GATE]).toBeDefined();
			const s = r.state as { task: string; tool: string; blocks: Record<string, string> };
			expect(s.task).toBe((reqs[0]!.state as any).task);
			expect(s.tool).toBe("read");
			expect(Object.keys(s.blocks)).toEqual(Object.keys(r.questions).filter((k) => k !== ERROR_GATE));
		}
		expect(Object.keys(reqs[2]!.questions)).toContain("b18");
	});

	test("0 (default) sends one request", async () => {
		const { judge, reqs } = recJudge((id) => (id === ERROR_GATE ? 0 : 0.9));
		await makeHandler(judge, cfg(), tcfg())(ev, ctx);
		expect(reqs.length).toBe(1);
	});

	test("merged answers across chunks drive decide()", async () => {
		const c = cfg();
		const drop = new Set(["b1", "b2", "b3", "b10", "b17"]); // chunks 1, 2, and 3
		const { judge } = recJudge((id) => (id === ERROR_GATE ? 0 : drop.has(id) ? 0 : 0.9));
		const out = await makeHandler(judge, c, tcfg({ maxBlocksPerCall: 8 }))(ev, ctx);
		const rec = log(c)[0];
		expect(rec.detail.outcome).toBe("pruned");
		expect(rec.detail.dropped).toBe(5);
		expect(rec.inputTokens).toBe(30);
		expect(out!.content[0].text.match(/\[pi-jev: hid lines/g)!.length).toBe(3);
	});

	test("an error answer >= 0.5 in any one chunk keeps everything", async () => {
		const c = cfg();
		let n = 0;
		const { judge } = recJudge((id) => (id === ERROR_GATE ? (++n === 3 ? 0.8 : 0) : 0));
		expect(await makeHandler(judge, c, tcfg({ maxBlocksPerCall: 8 }))(ev, ctx)).toBeUndefined();
		expect(log(c)[0].detail.outcome).toBe("errorgate");
	});

	test("chunks share one deadline: remaining budget shrinks, overrun fails open", async () => {
		const c = cfg({ timeoutMs: 100 });
		const { judge, reqs } = recJudge(() => 0, 40);
		expect(await makeHandler(judge, c, tcfg({ maxBlocksPerCall: 8 }))(ev, ctx)).toBeUndefined();
		expect(log(c)[0].detail.outcome).toBe("failopen");
		expect(reqs[1]!.timeoutMs!).toBeLessThan(reqs[0]!.timeoutMs!);
		expect(reqs[0]!.timeoutMs!).toBeLessThanOrEqual(100);
	});

	test("a failing chunk fails open: no partial rewrite", async () => {
		const c = cfg();
		let n = 0;
		const judge: Judge = {
			name: "mock",
			async ask(req) {
				if (++n === 2) throw new Error("boom");
				const answers: Record<string, any> = {};
				for (const id of Object.keys(req.questions)) answers[id] = { type: "noul", probability: 0 };
				return { answers, latencyMs: 1, backend: "mock" };
			},
		};
		expect(await makeHandler(judge, c, tcfg({ maxBlocksPerCall: 8 }))(ev, ctx)).toBeUndefined();
		expect(log(c)[0].detail.outcome).toBe("failopen");
	});
});

describe("per-judge triage overrides", () => {
	const s = {
		judge: "jevk5",
		triage: { drop: 0.1, keep: 0.5 },
		judges: { jevk5: { url: "http://127.0.0.1:47412", stateChars: 24000, drop: 0.2, keep: 0.6, maxBlocksPerCall: 8 } },
	};
	const env = (e: Record<string, string> = {}) => e as NodeJS.ProcessEnv;

	test("judges.<name> drop/keep/maxBlocksPerCall win over triage", () => {
		const t = loadTriageConfig(env(), s);
		expect([t.drop, t.keep, t.maxBlocksPerCall, t.stateCap]).toEqual([0.2, 0.6, 8, 24000]);
	});

	test("env wins over the named judge", () => {
		const t = loadTriageConfig(env({ PI_JEV_DROP: "0.05", PI_JEV_KEEP: "0.7", PI_JEV_MAX_BLOCKS_PER_CALL: "4" }), s);
		expect([t.drop, t.keep, t.maxBlocksPerCall]).toEqual([0.05, 0.7, 4]);
	});

	test("another judge keeps the triage values and defaults", () => {
		const t = loadTriageConfig(env({ PI_JEV_JUDGE: "vercel" }), s);
		expect([t.drop, t.keep, t.maxBlocksPerCall]).toEqual([0.1, 0.5, 0]);
		expect(loadTriageConfig(env(), {}).drop).toBe(0.2);
	});
});

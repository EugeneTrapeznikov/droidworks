import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTriageConfig } from "../../extension/src/triage/core.ts";
import { type Ask, identifiers, replaySession } from "./replay.ts";

const usage = (input: number, cacheRead: number) => ({ input, cacheRead, cost: { input: input * 5e-6, cacheRead: cacheRead * 5e-7 } });

test("replay prunes an eligible result, measures both timelines, and flags a later-used hidden block", async () => {
	const lines = Array.from({ length: 100 }, (_, i) => (i === 40 ? "export const sessionRefreshTtl = 1;" : `line ${i} padding padding padding`));
	const ents = [
		{ type: "session", cwd: "/w" },
		{ type: "message", id: "u1", message: { role: "user", content: "fix the refresh bug in src/auth/session.ts please, thanks" } },
		{ type: "message", id: "a1", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "x" } }], usage: usage(900, 0) } },
		{ type: "message", id: "r1", message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: lines.join("\n") }] } },
		{ type: "message", id: "r2", message: { role: "toolResult", toolCallId: "c2", toolName: "bash", content: [{ type: "text", text: JSON.stringify({ a: "x".repeat(3000) }) }] } },
		{ type: "message", id: "a2", message: { role: "assistant", content: [{ type: "text", text: "change sessionRefreshTtl" }], usage: usage(100, 3100) } },
	];
	const dir = mkdtempSync(join(tmpdir(), "session-replay-"));
	const path = join(dir, "s.jsonl");
	writeFileSync(path, ents.map((e) => JSON.stringify(e)).join("\n"));

	let asked = 0;
	const ask: Ask = async (req) => {
		asked++;
		const answers = Object.fromEntries(Object.keys(req.questions).map((id) => [id, { type: "noul" as const, probability: 0 }]));
		return { res: { answers, latencyMs: 5, backend: "fake" }, attempts: 1 };
	};
	const r = await replaySession(path, ask, loadTriageConfig({ PI_JEV_JUDGE: "vercel", PI_CODING_AGENT_DIR: dir }));

	expect(asked).toBe(1); // the JSON body is skipped without a judge call
	expect(r.structured).toBe(1);
	expect([r.calls, r.eligible, r.judged, r.pruned, r.stubs]).toEqual([2, 1, 1, 1, 1]);
	expect(r.hiddenChars).toBeGreaterThan(0.2 * r.eligibleChars);
	expect(r.savedPctLast).toBeGreaterThan(0); // second call saw the stub instead of the middle blocks
	expect(r.savedPctMean).toBeLessThan(r.savedPctLast); // first call only pays the 155-token overhead
	expect(r.flagged).toBe(1);
	const flagged = r.hidden.find((h) => h.matches.length)!;
	expect(flagged.matches).toEqual(["sessionRefreshTtl"]);
	expect(flagged.soon).toBe(true); // mentioned in the very next call
	expect(r.hidden.some((h) => h.recalled)).toBe(false); // no later read of the same path
	expect(flagged.uniqueLoss).toBe(true); // sessionRefreshTtl was visible nowhere else
});

test("identifiers strip trailing punctuation and need _, / or camelCase", () => {
	expect(identifiers("see src/foo/bar.ts. and fooBarBaz, plainword and snake_case_x")).toEqual(["src/foo/bar.ts", "fooBarBaz", "snake_case_x"]);
});

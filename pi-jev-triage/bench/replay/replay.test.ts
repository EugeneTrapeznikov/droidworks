import { QUESTION_SETS, ERROR_GATE, loadTriageConfig, makeHandler, splitBlocks } from "../../extension/src/triage/core.ts";
import { loadConfig } from "../../extension/src/telemetry.ts";
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distinctiveLines, identifiers, forEachTurn, sessionFiles, type Turn } from "./corpus.ts";
import { blockNeeded, extractTurn, type TriageCase } from "./extract.ts";
import { Hist } from "./score.ts";
import { MockJudge } from "../../extension/src/judge/index.ts";
import { buildRequests, defaultTimeoutMs, stratifiedPick } from "./judge.ts";

// --- text helpers ---

test("distinctiveLines skips short and brace-only lines", () => {
  expect(distinctiveLines("  }\n{\n  short\n  const answer = computeTheAnswer(input);\n")).toEqual([
    "const answer = computeTheAnswer(input);",
  ]);
});

test("identifiers require length, a letter, and a separator or camelCase", () => {
  const ids = identifiers("see src/foo/bar.ts and computeTheAnswer and 1234567890 and plainword");
  expect(ids).toContain("src/foo/bar.ts");
  expect(ids).toContain("computeTheAnswer");
  expect(ids).not.toContain("1234567890");
  expect(ids).not.toContain("plainword");
});

// --- triage labeler ---

const EV = (o: Partial<Parameters<typeof blockNeeded>[1]> = {}) =>
  ({ editLines: new Set<string>(), readPaths: [], finalIdents: new Set<string>(), ...o });

test("blockNeeded: edit reusing a distinctive line", () => {
  const block = "  const answer = computeTheAnswer(input);\n  }";
  expect(blockNeeded(block, EV({ editLines: new Set(["const answer = computeTheAnswer(input);"]) }))).toBe(true);
  expect(blockNeeded(block, EV({ editLines: new Set(["something else entirely here ok"]) }))).toBe(false);
});

test("blockNeeded: later read of a path named in the block", () => {
  expect(blockNeeded("see src/app/main.ts here", EV({ readPaths: ["src/app/main.ts"] }))).toBe(true);
  expect(blockNeeded("nothing relevant", EV({ readPaths: ["src/app/main.ts"] }))).toBe(false);
});

test("blockNeeded: final answer quoting a distinctive identifier", () => {
  expect(blockNeeded("the flag is enableFastPath today", EV({ finalIdents: new Set(["enableFastPath"]) }))).toBe(true);
  expect(blockNeeded("nothing here", EV({ finalIdents: new Set(["enableFastPath"]) }))).toBe(false);
});

// --- per-turn extraction on a synthetic turn ---

function collect(turn: Turn) {
  const got: TriageCase[] = [];
  extractTurn("sess", turn, c => got.push(c));
  return got;
}

const big = (marker: string) => [
  ...Array.from({ length: 30 }, (_, i) => `filler line number ${i} with enough characters to be distinctive`),
  marker,
  ...Array.from({ length: 30 }, (_, i) => `tail line number ${i} with enough characters to be distinctive`),
].join("\n");

test("extractTurn labels triage blocks from later edits", () => {
  const text = big("  const answer = computeTheAnswer(input);");
  const turn: Turn = {
    index: 0, prompt: "fix the answer computation",
    events: [
      { r: "assistant", text: "Let me look at the file.", calls: [{ id: "c1", name: "read", args: { path: "src/a.ts" } }] },
      { r: "toolResult", callId: "c1", name: "read", text, isError: false },
      { r: "assistant", text: "", calls: [{ id: "c2", name: "edit", args: { oldText: "const answer = computeTheAnswer(input);", newText: "const answer = 42;" } }] },
      { r: "toolResult", callId: "c2", name: "edit", text: "ok", isError: false },
      { r: "assistant", text: "Done.", calls: [] },
    ],
  };
  const got = collect(turn);
  const t = got[0];
  expect(got.length).toBe(1);
  expect(t).toBeDefined();
  expect(t.tool).toBe("read");
  expect(t.blocks.length).toBe(3);
  expect(t.blocks.filter(b => b.needed).length).toBe(1);
  expect(t.blocks[1].needed).toBe(true);
  expect(t.task.prompt).toBe("fix the answer computation");
  expect(t.task.lastAssistant).toBe("Let me look at the file.");
});

test("extractTurn task: a filler turn uses the earlier substantive prompt and the previous turn's assistant text", () => {
  const real = "fix the answer computation in src/a.ts so it handles empty input";
  const turn: Turn = {
    index: 1, prompt: "continue",
    events: [{ r: "toolResult", callId: "c1", name: "read", text: big("x = 1;"), isError: false }],
  };
  const got: TriageCase[] = [];
  extractTurn("sess", turn, c => got.push(c), { prompts: [real, "continue"], assistant: "Next I will read src/a.ts." });
  expect(got[0]!.task).toEqual({ prompt: real, lastAssistant: "Next I will read src/a.ts." });
});

// --- session reader on a synthetic JSONL ---

test("forEachTurn splits on user messages and skips system messages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-replay-"));
  const f = join(dir, "s.jsonl");
  const L = (m: any) => JSON.stringify({ type: "message", message: m });
  writeFileSync(f, [
    JSON.stringify({ type: "session", version: 3 }),
    L({ role: "system", sections: { skills: "<skill><name>tdd</name><description>d</description></skill>" }, toolsAdded: [{ name: "read", description: "r" }, { name: "web_search", description: "w" }] }),
    L({ role: "user", content: "one" }),
    L({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }] }),
    L({ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "hi" }] }),
    L({ role: "system", toolsRemoved: [{ name: "web_search" }] }),
    L({ role: "user", content: "two" }),
  ].join("\n") + "\n");
  const turns: Turn[] = [];
  await forEachTurn(f, t => { turns.push(structuredClone(t)); });
  expect(turns.map(t => t.prompt)).toEqual(["one", "two"]);
  expect(turns[0].events.length).toBe(2);
  expect(turns[0].events.map(e => e.r)).toEqual(["assistant", "toolResult"]);
});

test("sessionFiles applies the 50 KB floor", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sessions-"));
  mkdirSync(join(root, "proj"));
  writeFileSync(join(root, "proj", "big.jsonl"), "x".repeat(60_000));
  writeFileSync(join(root, "proj", "small.jsonl"), "x");
  expect(sessionFiles(root).map(p => p.split("/").pop())).toEqual(["big.jsonl"]);
});

// --- metrics ---

test("Hist.auc matches the textbook value on a tiny set", () => {
  const h = new Hist(1000);
  // scores 0.9,0.6 positive; 0.5,0.2 negative -> perfect separation
  h.add(0.9, true); h.add(0.6, true); h.add(0.5, false); h.add(0.2, false);
  expect(h.auc()).toBeCloseTo(1, 6);
  const g = new Hist(1000);
  g.add(0.9, false); g.add(0.6, true); g.add(0.5, false); g.add(0.2, true);
  expect(g.auc()).toBeCloseTo(0.25, 6);
});

test("Hist.auc counts ties at half weight", () => {
  const h = new Hist(1000);
  h.add(0.5, true); h.add(0.5, false);
  expect(h.auc()).toBeCloseTo(0.5, 6);
});

test("Hist.ece is zero for a perfectly calibrated set and 1 for a fully wrong one", () => {
  const ok = new Hist(1000);
  for (let i = 0; i < 100; i++) ok.add(0.05, false);      // bin 0: predicted .05, observed 0
  expect(ok.ece(10)).toBeCloseTo(0.05, 6);
  const bad = new Hist(1000);
  for (let i = 0; i < 100; i++) bad.add(0.95, false);
  expect(bad.ece(10)).toBeCloseTo(0.95, 6);
});

test("stratifiedPick round-robins so a rare stratum survives", () => {
  const metas = [
    ...Array.from({ length: 100 }, (_, i) => ({ n: i, tokens: 1, stratum: "big" })),
    ...Array.from({ length: 3 }, (_, i) => ({ n: 100 + i, tokens: 1, stratum: "rare" })),
  ];
  const picked = stratifiedPick(metas, 10);
  expect(picked.size).toBe(10);
  expect([...picked].filter(n => n >= 100).length).toBe(3);
});

// --- judges (shared factory) ---

test("mock judge is deterministic", async () => {
  const req = { state: { task: "t" }, questions: { b0: { type: "noul", instructions: "?" } } } as any;
  const a = await new MockJudge({}).ask(req), b = await new MockJudge({}).ask(req);
  expect((a.answers.b0 as any).probability).toBe((b.answers.b0 as any).probability);
});

// --- request shape ---

const triageCase = (n: number, blockChars = 5): TriageCase => ({
  id: "x", feature: "triage", session: "s", tool: "read", bytes: 10, truncated: false,
  task: { prompt: "p", lastAssistant: "a" },
  blocks: Array.from({ length: n }, (_, i) => ({ i, startLine: i * 25 + 1, endLine: i * 25 + 25, chars: blockChars, text: "t".repeat(blockChars), needed: false })),
});

test("buildRequests sends the extension's state: task, tool, full blocks under their ids", () => {
  const [r, ...rest] = buildRequests(triageCase(2), 750, 24_000);
  expect(rest).toEqual([]);
  expect(Object.keys(r.questions)).toEqual([ERROR_GATE, "b0", "b1"]);
  expect((r.questions[ERROR_GATE] as any).instructions).toBe(QUESTION_SETS.winnow.error);
  expect(Object.values(r.questions).every(q => q.type === "noul")).toBe(true);
  expect((r.questions.b1 as any).instructions).toBe(QUESTION_SETS.winnow.block("b1"));
  expect(r.state).toEqual({ task: "Task: p\nLatest agent note: a", tool: "read", blocks: { b0: "ttttt", b1: "ttttt" } });
});

test("buildRequests judges only the leading run of blocks that fits the state cap", () => {
  const [r] = buildRequests(triageCase(40, 1000), 750, 12_000);
  const ids = Object.keys((r.state as any).blocks);
  expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => `b${i}`));
  expect(ids.length).toBe(11); // (12000 - 29 task - 4 tool) / 1000
  expect(Object.keys(r.questions)).toEqual([ERROR_GATE, ...ids]);
  expect(Object.values((r.state as any).blocks).every(v => v === "t".repeat(1000))).toBe(true);
  expect(buildRequests(triageCase(3, 20_000), 750, 12_000)).toEqual([]);
});


test("the judge deadline comes from PI_JEV_TIMEOUT_MS, default 15000", () => {
  const saved = process.env.PI_JEV_TIMEOUT_MS;
  try {
    delete process.env.PI_JEV_TIMEOUT_MS;
    expect(defaultTimeoutMs()).toBe(15_000);
    process.env.PI_JEV_TIMEOUT_MS = "3000";
    expect(defaultTimeoutMs()).toBe(3000);
  } finally {
    if (saved === undefined) delete process.env.PI_JEV_TIMEOUT_MS;
    else process.env.PI_JEV_TIMEOUT_MS = saved;
  }
});

test("askWithBackoff retries 429 then returns, and rethrows non-retryable errors", async () => {
  const { askWithBackoff } = await import("./judge.ts");
  let n = 0;
  const flaky: any = { name: "flaky", ask: async () => { if (n++ < 2) throw Object.assign(new Error("rl"), { status: 429 }); return { answers: {}, latencyMs: 1, backend: "flaky" }; } };
  expect((await askWithBackoff(flaky, {} as any, 5, 1)).backend).toBe("flaky");
  expect(n).toBe(3);
  const bad: any = { name: "bad", ask: async () => { throw Object.assign(new Error("no"), { status: 401 }); } };
  await expect(askWithBackoff(bad, {} as any, 5, 1)).rejects.toThrow("no");
});

test("breaker trips under 50% success over the window and stops retries", async () => {
  const { noteAttempt, breaker, askWithBackoff } = await import("./judge.ts");
  for (let i = 0; i < 50; i++) noteAttempt(i % 3 === 0); // 17/50 ok
  expect(breaker.tripped).toBe(true);
  const ok: any = { name: "ok", ask: async () => ({ answers: {}, latencyMs: 1, backend: "ok" }) };
  await expect(askWithBackoff(ok, {} as any, 5, 1)).rejects.toThrow("breaker");
  breaker.tripped = false;
});

test("replay request == the extension's request for the same tool result", async () => {
  const text = Array.from({ length: 300 }, (_, i) => `line ${i} ` + "z".repeat(i % 7 === 0 ? 3000 : 50)).join("\n");
  const cfg = { ...loadConfig({} as any, {}), shadow: true };
  const tcfg = { ...loadTriageConfig({} as any, {}), stateCap: 12_000 };
  let sent: any;
  const capture = { name: "capture", ask: async (req: any) => { sent = req; return { answers: {}, latencyMs: 0, backend: "capture" }; } };
  const ctx = { sessionManager: { getBranch: () => [
    { message: { role: "user", content: "fix the parser" } },
    { message: { role: "assistant", content: [{ type: "text", text: "Looking. Now reading the parser." }] } },
  ] } };
  await makeHandler(capture, cfg, tcfg)({ toolName: "bash", toolCallId: "c1", content: [{ type: "text", text }] }, ctx);

  const c: TriageCase = {
    id: "x", feature: "triage", session: "s", tool: "bash", bytes: text.length, truncated: false,
    task: { prompt: "fix the parser", lastAssistant: "Looking. Now reading the parser." },
    blocks: splitBlocks(text, tcfg.blockLines, 1, tcfg.blockChars).map((b, i) => ({
      i, startLine: b.start, endLine: b.end, chars: b.text.length, text: b.text, needed: false,
      ...(b.from !== undefined && { from: b.from, to: b.to }),
    })),
  };
  const [r, ...rest] = buildRequests(c, cfg.timeoutMs, tcfg.stateCap);
  expect(rest).toEqual([]);
  expect(r).toEqual(sent); // state, questions (error question included) and deadline, byte for byte
  expect(r.questions[ERROR_GATE]).toBeDefined();
  expect(Object.keys(r.state.blocks as object).length).toBeLessThan(c.blocks.length); // cap actually bit
  expect(c.blocks.some(b => b.from !== undefined)).toBe(true); // long lines were hard-split
});

test("score applies the judge's error answer (≥ 0.5 keeps all), no regex", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-jev-replay-"));
  mkdirSync(join(root, "cases")); mkdirSync(join(root, "judged"));
  const blocks = Array.from({ length: 10 }, (_, i) => ({
    i, startLine: i * 25 + 1, endLine: i * 25 + 25, chars: 200,
    text: (i === 3 ? "Traceback (most recent call last):\n" : "") + "q".repeat(200), needed: false,
  }));
  const cases = ["gated", "clean"].map(id => ({ ...triageCase(0), id, blocks }));
  writeFileSync(join(root, "cases", "triage.jsonl"), cases.map(c => JSON.stringify(c)).join("\n") + "\n");
  const answers = (err: number) => ({ [ERROR_GATE]: { type: "noul", probability: err },
    ...Object.fromEntries(blocks.map(b => [`b${b.i}`, { type: "noul", probability: 0 }])) });
  writeFileSync(join(root, "judged", "triage.mock.jsonl"), [
    { id: "gated", feature: "triage", backend: "mock", requests: 1, latencyMs: 1, inputTokens: 1, answers: answers(0.7) },
    { id: "clean", feature: "triage", backend: "mock", requests: 1, latencyMs: 1, inputTokens: 1, answers: answers(0.1) },
  ].map(r => JSON.stringify(r)).join("\n") + "\n");
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "cli.ts"), "score", "--judge", "mock"], { env: { ...process.env, PI_JEV_REPLAY: root } });
  expect(p.exitCode).toBe(0);
  const s = JSON.parse(readFileSync(join(root, "scores", "triage.mock.json"), "utf8"));
  // "clean" carries a traceback too; only the judge's answer decides
  expect([s.policy.errorGateCases, s.policy.prunedCases]).toEqual([1, 1]);
});

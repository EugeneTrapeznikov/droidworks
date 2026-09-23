import { expect, test } from "bun:test";
import { loadRoutingSet, validateRoutingSet, parseSession, ARMS, piArgs, DEFAULT_PROVIDER, DEFAULT_MODEL, type RoutingSet, type RunResult } from "./run.ts";
import { scoreArm, scoreTriage, pct, median } from "./score.ts";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- routing set ---------------------------------------------------------

test("routing-set.json matches the schema", () => {
  const set = loadRoutingSet();
  expect(set.items.length).toBe(30);
  expect(set.items.filter(i => i.none).length).toBe(12);
  expect(set.items.filter(i => !i.none && i.expect_skills.length && !i.expect_tools.length).length).toBe(10);
  expect(set.items.filter(i => i.expect_tools.length).length).toBe(8);
});

test("validateRoutingSet rejects none/expect contradictions", () => {
  const bad: RoutingSet = {
    version: 1,
    base_tools: ["read"],
    items: [{ id: "x", prompt: "a prompt long enough", expect_skills: ["tdd"], expect_tools: [], none: true }],
  };
  expect(() => validateRoutingSet(bad)).toThrow(/contradicts/);
});

test("validateRoutingSet rejects base tools in expectations and duplicate ids", () => {
  const base = { prompt: "a prompt long enough", expect_skills: [], none: false };
  expect(() =>
    validateRoutingSet({ version: 1, base_tools: ["read"], items: [{ id: "x", ...base, expect_tools: ["read"] }] } as RoutingSet),
  ).toThrow(/base tool/);
  expect(() =>
    validateRoutingSet({
      version: 1,
      base_tools: ["read"],
      items: [
        { id: "x", ...base, expect_tools: ["subagent"] },
        { id: "x", ...base, expect_tools: ["subagent"] },
      ],
    } as RoutingSet),
  ).toThrow(/duplicate/);
});

test("arm table is off plus triage per judge", () => {
  expect(Object.keys(ARMS).sort()).toEqual(["off", "triage-local", "triage-vercel"]);
  expect(ARMS.off).toBeNull();
  expect(ARMS["triage-local"]).toMatchObject({ PI_JEV_FEATURES: "triage", PI_JEV_JUDGE: "local", PI_JEV_SHADOW: "0" });
  // PI_JEV_LOCAL_URL / VERCEL_API_KEY are never in an overlay: they ride the ambient env into `pi`
  for (const overlay of Object.values(ARMS)) {
    if (!overlay) continue;
    expect(Object.keys(overlay).sort()).toEqual(["PI_JEV_FEATURES", "PI_JEV_JUDGE", "PI_JEV_SHADOW"]);
  }
});

test("pi args always name the provider and model, extension only for triage arms", () => {
  const m = { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
  expect(m).toEqual({ provider: "openai-codex", model: "gpt-6-sol" });
  const off = piArgs("/s", m, false, "hi");
  expect(off).toEqual(["-p", "--session-dir", "/s", "--no-context-files", "--provider", "openai-codex", "--model", "gpt-6-sol", "hi"]);
  const tri = piArgs("/s", m, true, "hi");
  expect(tri.slice(-3, -1)[0]).toBe("-e");
  expect(tri.at(-1)).toBe("hi");
});

// --- math ----------------------------------------------------------------

test("pct and median", () => {
  expect(median([3, 1, 2])).toBe(2);
  expect(pct([1, 2, 3, 4], 50)).toBe(2);
  expect(pct([1, 2, 3, 4], 95)).toBe(4);
  expect(pct([], 50)).toBeNull();
});

test("parseSession sums message.usage and takes the first call as first-turn", () => {
  const dir = mkdtempSync(join(tmpdir(), "sess-"));
  mkdirSync(join(dir, "moa-harness"), { recursive: true }); // subdirectory logs must be ignored
  writeFileSync(join(dir, "moa-harness", "advisors.jsonl"), JSON.stringify({ usage: { input: 999 } }) + "\n");
  writeFileSync(
    join(dir, "s.jsonl"),
    [
      JSON.stringify({ type: "session" }),
      JSON.stringify({ type: "message", message: { usage: { input: 13398, output: 5, cacheRead: 0, cost: { total: 0.05 } } } }),
      JSON.stringify({
        type: "message",
        message: {
          content: [{ type: "toolCall", name: "pi_jev_recall" }, { type: "toolCall", name: "read" }, { type: "text", text: "hi" }],
          usage: { input: 400, output: 20, cacheRead: 13312, cost: { total: 0.01 } },
        },
      }),
      JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "a\n[pi-jev: hid lines 2–9 (8 lines)]\nb\n[pi-jev: hid lines 12–30 (19 lines)]" }] } }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "[pi-jev: hid lines 1–2" }] } }),
      "not json",
    ].join("\n"),
  );
  const u = parseSession(dir);
  expect(u.stubs).toBe(2); // only tool results the model saw count, not prompt text
  expect(u).toMatchObject({ firstTurnInput: 13398, firstTurnCacheRead: 0, calls: 2, totalInput: 13798, totalCacheRead: 13312, totalOutput: 25 });
  expect(u.toolCalls).toEqual({ pi_jev_recall: 1, read: 1 });
  expect(u.cost).toBeCloseTo(0.06, 6);
});

// --- arm scoring ---------------------------------------------------------

function run(id: string, decisions: unknown[], firstTurnInput = 5000, firstTurnCacheRead = 0, toolCalls: Record<string, number> = {}): RunResult {
  return {
    arm: "a", id, prompt: "", ok: true, exitCode: 0, wallMs: 1000,
    firstTurnInput, firstTurnCacheRead, calls: 2, totalInput: firstTurnInput, totalCacheRead: 0, totalOutput: 10, cost: 0.01, toolCalls, decisions,
  };
}

test("prefix size adds first-turn cacheRead so implicit cross-session cache hits stay comparable", () => {
  const s = scoreArm(
    "off",
    [
      run("s1", [], 13539, 0),    // cold miss
      run("t1", [], 6736, 6912),  // same prefix, mostly served from the implicit cache
      run("n1", [], 6987, 6912),
    ],
    null,
  );
  expect(s.firstMedian).toBe(13648);  // 6736+6912 -> within 1% of the cold 13539
  expect(s.coldN).toBe(1);
  expect(s.coldMedian).toBe(13539);
});

test("scoreArm reports cost, Δ vs off and judge latency from triage records only", () => {
  const s = scoreArm("triage-local", [
    run("a", [{ feature: "triage", latencyMs: 40, detail: {} }, { feature: "triage", latencyMs: 90, detail: {} }], 5000),
    run("b", [{ feature: "prefix", latencyMs: 999, detail: {} }], 5000),
  ], 6000);
  expect(s.deltaVsOff).toBe(-1000);
  expect(s.cost).toBeCloseTo(0.02, 6);
  expect([s.judgeP50, s.judgeP95]).toEqual([40, 90]);
  expect(scoreArm("off", [run("s1", [])], null).judgeP50).toBeNull();
});

// --- triage ----------------------------------------------------------------

const tri = (detail: Record<string, unknown>) => ({ feature: "triage", latencyMs: 40, detail });

test("scoreTriage measures hidden bytes over every judged result and counts recall turns", () => {
  const t = scoreTriage([
    run("a", [tri({ bytesBefore: 1000, bytesAfter: 400, outcome: "pruned" })], 1, 0, { pi_jev_recall: 2, read: 5 }),
    run("b", [tri({ bytesBefore: 1000, bytesAfter: 1000, outcome: "errorgate" })]),
    run("c", [tri({ bytesBefore: 1000, bytesAfter: 1000, outcome: "skip_ratio" })]),
    // fail-open records carry no bytesAfter; they must count as nothing hidden, not as everything hidden
    run("d", [tri({ bytesBefore: 1000, outcome: "failopen" })]),
  ]);
  expect(t.decisions).toBe(4);
  expect(t.bytesBefore).toBe(4000);
  expect(t.bytesAfter).toBe(3400);
  expect(t.hiddenPct).toBeCloseTo(0.15, 6);
  expect([t.pruned, t.errorGate, t.skipRatio, t.failOpen]).toEqual([1, 1, 1, 1]);
  expect(t.recallTurns).toBe(2);
});

// --- fixture -------------------------------------------------------------

test("ensureFixture materializes the repo and reset wipes prompt side effects", async () => {
  const { ensureFixture } = await import("./run.ts");
  const dir = mkdtempSync(join(tmpdir(), "fix-"));
  ensureFixture(dir);
  expect(readdirSync(dir).sort()).toEqual(["README.md", "docs", "package.json", "src"]);
  expect(readFileSync(join(dir, "src/store.ts"), "utf8")).toContain("class WidgetStore");

  // a prompt run leaves junk behind in the cwd (scheduled jobs, new test files, edits)
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi/schedule-prompts.json"), "[{}]");
  writeFileSync(join(dir, "src/store.test.ts"), "// written by a previous arm");
  writeFileSync(join(dir, "src/util.ts"), "// clobbered");

  ensureFixture(dir);                      // no reset: junk survives
  expect(existsSync(join(dir, ".pi"))).toBe(true);
  expect(readFileSync(join(dir, "src/util.ts"), "utf8")).toBe("// clobbered");

  ensureFixture(dir, true);                // reset: back to pristine
  expect(existsSync(join(dir, ".pi"))).toBe(false);
  expect(existsSync(join(dir, "src/store.test.ts"))).toBe(false);
  expect(readFileSync(join(dir, "src/util.ts"), "utf8")).toContain("parseLimit");
});

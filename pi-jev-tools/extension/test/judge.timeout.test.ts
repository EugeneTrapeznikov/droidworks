import { afterEach, describe, expect, test } from "bun:test";
import type { Judge, JevConfig, Question } from "../src/judge/types.ts";
import { JudgeError } from "../src/judge/shared.ts";
import { TypeSafeJudge } from "../src/judge/typesafe.ts";
import { askOrNull, withDeadline } from "../src/judge/index.ts";
import { MockJudge } from "../src/judge/mock.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const QUESTIONS: Record<string, Question> = { refund: { type: "noul", instructions: "Refund?" } };
const CFG: JevConfig = { judge: "mock", shadow: true, features: new Set(), timeoutMs: 750 };

/** Hangs until the caller's AbortController fires. */
function hangingFetch(): void {
  globalThis.fetch = ((_url: any, init: any) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch;
}

describe("timeout", () => {
  test("AbortController turns a hanging request into a timeout JudgeError", async () => {
    hangingFetch();
    const t0 = Date.now();
    const err = await new TypeSafeJudge({ apiKey: "k", timeoutMs: 40 }).ask({ state: "x", questions: QUESTIONS }).catch((e) => e);
    expect(err).toBeInstanceOf(JudgeError);
    expect(err.kind).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test("per-request timeoutMs overrides the backend default", async () => {
    hangingFetch();
    const t0 = Date.now();
    const err = await new TypeSafeJudge({ apiKey: "k", timeoutMs: 60_000 })
      .ask({ state: "x", questions: QUESTIONS, timeoutMs: 40 })
      .catch((e) => e);
    expect(err.kind).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test("a slow body read also trips the deadline", async () => {
    // Headers arrive, the body never does; the abort tears down the stream mid-read.
    globalThis.fetch = (async (_url: any, init: any) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    const err = await new TypeSafeJudge({ apiKey: "k", timeoutMs: 40 }).ask({ state: "x", questions: QUESTIONS }).catch((e) => e);
    expect(err).toBeInstanceOf(JudgeError);
    expect(err.kind).toBe("timeout");
  });
});

describe("withDeadline", () => {
  test("passes a value through", async () => {
    await expect(withDeadline(Promise.resolve(7), 1000)).resolves.toBe(7);
  });

  test("rejects a slow promise with a timeout JudgeError", async () => {
    const err = await withDeadline(new Promise((r) => setTimeout(r, 5000)), 30, "triage").catch((e) => e);
    expect(err).toBeInstanceOf(JudgeError);
    expect(err.kind).toBe("timeout");
    expect(err.message).toContain("triage");
  });
});

describe("askOrNull", () => {
  const noLog = { ...CFG, logPath: undefined };

  test("returns the response on success", async () => {
    const res = await askOrNull(new MockJudge({ seed: "s" }), { state: "x", questions: QUESTIONS }, { cfg: noLog, feature: "triage" });
    expect(res?.backend).toBe("mock");
  });

  test("returns null on timeout instead of throwing", async () => {
    hangingFetch();
    const res = await askOrNull(new TypeSafeJudge({ apiKey: "k", timeoutMs: 30 }), { state: "x", questions: QUESTIONS }, { cfg: noLog, feature: "triage" });
    expect(res).toBeNull();
  });

  test("returns null on any throw, including a non-JudgeError", async () => {
    const broken: Judge = {
      name: "broken",
      ask: async () => {
        throw new TypeError("boom");
      },
    };
    expect(await askOrNull(broken, { state: "x", questions: QUESTIONS })).toBeNull();
  });

  test("records latency and the error kind to the decision log", async () => {
    const logPath = `${process.env.TMPDIR ?? "/tmp"}/pi-jev-test-${Date.now()}.jsonl`;
    const cfg: JevConfig = { ...CFG, logPath };
    hangingFetch();
    await askOrNull(new TypeSafeJudge({ apiKey: "k", timeoutMs: 30 }), { state: "x", questions: QUESTIONS }, { cfg, feature: "triage" });
    await askOrNull(new MockJudge(), { state: "x", questions: QUESTIONS }, { cfg, feature: "triage", detail: { blocks: 3 } });

    const lines = (await Bun.file(logPath).text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ feature: "triage", backend: "typesafe", detail: { ok: false, error: "timeout" } });
    expect(typeof lines[0].latencyMs).toBe("number");
    expect(lines[1]).toMatchObject({ feature: "triage", backend: "mock", detail: { ok: true, blocks: 3 } });
  });
});

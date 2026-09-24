import { describe, expect, test } from "bun:test";
import type { JudgeRequest, Question } from "../src/judge/types.ts";
import { MockJudge, stateText } from "../src/judge/mock.ts";
import { createJudge } from "../src/judge/index.ts";
import { loadConfig } from "../src/telemetry.ts";

const QUESTIONS: Record<string, Question> = {
  route: {
    type: "choice",
    instructions: "Which team handles this?",
    criteria: {
      billing: "refunds charges payments and invoices",
      shipping: "delivery tracking and lost parcels",
      technical: "application bugs crashes and outages",
    },
  },
  urgent: { type: "noul", instructions: "Does this convey urgency?", subject: "does this convey urgency" },
  quality: { type: "score", instructions: "Rate the urgency of this ticket", criteria: ["low", "medium", "high"] },
};

const REQ: JudgeRequest = { state: "My card was charged twice and I want a refund for the duplicate invoice.", questions: QUESTIONS };

describe("mock", () => {
  test("same seed gives the same answers, different seed differs", async () => {
    const a = await new MockJudge({ seed: "s1" }).ask(REQ);
    const b = await new MockJudge({ seed: "s1" }).ask(REQ);
    const c = await new MockJudge({ seed: "s2" }).ask(REQ);
    expect(a.answers).toEqual(b.answers);
    expect(JSON.stringify(a.answers)).not.toBe(JSON.stringify(c.answers));
  });

  test("answers match the requested question types and the criteria sets", async () => {
    const res = await new MockJudge({ seed: 7 }).ask(REQ);
    const route = res.answers.route;
    if (route.type !== "choice") throw new Error("expected choice");
    expect(Object.keys(QUESTIONS.route.type === "choice" ? QUESTIONS.route.criteria : {})).toContain(route.choice);
    expect(Object.values(route.probabilities).reduce((x, y) => x + y, 0)).toBeCloseTo(1, 10);
    expect(res.answers.urgent.type).toBe("noul");
    expect(res.answers.quality.type).toBe("score");
  });

  test("fixtures override the seed", async () => {
    const res = await new MockJudge({
      seed: "s1",
      fixtures: { urgent: { type: "noul", probability: 0.42 } },
    }).ask(REQ);
    expect(res.answers.urgent).toEqual({ type: "noul", probability: 0.42 });
  });

  test("stateText stringifies structured state", () => {
    expect(stateText("s")).toBe("s");
    expect(stateText({ a: 1 })).toBe('{"a":1}');
  });
});

describe("factory", () => {
  const cfg = (judge: string, extra: Record<string, unknown> = {}) =>
    ({ ...loadConfig({} as any, {}), judge, ...extra }) as any;

  test("builds each backend by cfg.judge", () => {
    expect(createJudge(cfg("mock"), {}).name).toBe("mock");
    expect(createJudge(cfg("vercel"), { VERCEL_API_KEY: "k" }).name).toBe("vercel");
    expect(createJudge(cfg("typesafe"), { TYPESAFE_API_KEY: "k" }).name).toBe("typesafe");
    expect(createJudge(cfg("local"), { PI_JEV_LOCAL_URL: "http://127.0.0.1:1" }).name).toBe("local");
  });

  test("local without a URL and an unknown judge are config errors", () => {
    expect(() => createJudge(cfg("local"), {})).toThrow(/PI_JEV_LOCAL_URL/);
    expect(() => createJudge(cfg("nope"), {})).toThrow(/unknown judge/);
    expect(() => createJudge(cfg("lexical"), {})).toThrow(/unknown judge/);
  });
});

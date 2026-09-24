import { afterEach, describe, expect, test } from "bun:test";
import type { Question } from "../src/judge/types.ts";
import { JudgeError } from "../src/judge/shared.ts";
import { TypeSafeJudge, systemOneUrl } from "../src/judge/typesafe.ts";
import { VercelJudge, toGatewayQuestions } from "../src/judge/vercel.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Captured {
  url: string;
  init: RequestInit;
  body: any;
}

function stubFetch(response: unknown, status = 200): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return new Response(typeof response === "string" ? response : JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

const QUESTIONS: Record<string, Question> = {
  route: {
    type: "choice",
    instructions: "Route this ticket.",
    criteria: { billing: "payment problems", shipping: "delivery problems" },
  },
  refund: { type: "noul", instructions: "Is a refund requested?" },
  urgency: { type: "score", instructions: "How urgent?", criteria: ["low", "medium", "high"] },
};

describe("typesafe backend", () => {
  test("posts the TypeSafe wire shape and parses the TypeSafe response", async () => {
    const calls = stubFetch({
      model: "jev-1.13.0",
      answers: {
        route: { type: "choice", choice: "billing", probabilities: { billing: 0.9, shipping: 0.1 }, confidence: 0.88 },
        refund: { type: "noul", noul: 0.98 },
        urgency: { type: "score", score: 1.9, probabilities: { "0": 0.05, "1": 0.15, "2": 0.8 } },
      },
      usage: { input_tokens: 275, output_tokens: 20 },
    });

    const res = await new TypeSafeJudge({ apiKey: "k", timeoutMs: 5000 }).ask({ state: "charged twice", questions: QUESTIONS });

    expect(calls[0].url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((calls[0].init.headers as any).authorization).toBe("Bearer k");
    expect(calls[0].body).toEqual({ model: "jev-latest", state: "charged twice", questions: QUESTIONS });
    // noul goes out unchanged on this dialect
    expect(calls[0].body.questions.refund.type).toBe("noul");

    expect(res.backend).toBe("typesafe");
    expect(res.answers.route).toEqual({
      type: "choice",
      choice: "billing",
      probabilities: { billing: 0.9, shipping: 0.1 },
      confidence: 0.88,
    });
    expect(res.answers.refund).toEqual({ type: "noul", probability: 0.98 });
    expect(res.answers.urgency).toEqual({
      type: "score",
      level: "high",
      probabilities: { low: 0.05, medium: 0.15, high: 0.8 },
    });
    expect(res.usage).toEqual({ inputTokens: 275, outputTokens: 20 });
  });

  test("relabels score probabilities through `legend`", async () => {
    stubFetch({
      answers: { urgency: { type: "score", score: 0.2, legend: { a: "low", b: "medium", c: "high" }, probabilities: { a: 0.8, b: 0.15, c: 0.05 } } },
      usage: { input_tokens: 10 },
    });
    const res = await new TypeSafeJudge({ apiKey: "k" }).ask({ state: "x", questions: { urgency: QUESTIONS.urgency } });
    expect(res.answers.urgency).toEqual({ type: "score", level: "low", probabilities: { low: 0.8, medium: 0.15, high: 0.05 } });
  });

  test("falls back to a one-hot level when only `score` is returned", async () => {
    stubFetch({ answers: { urgency: { type: "score", score: 1.4 } } });
    const res = await new TypeSafeJudge({ apiKey: "k" }).ask({ state: "x", questions: { urgency: QUESTIONS.urgency } });
    expect(res.answers.urgency).toEqual({ type: "score", level: "medium", probabilities: { medium: 1 } });
  });

  test("local sidecar sends no Authorization header", async () => {
    const calls = stubFetch({ answers: { refund: { type: "noul", noul: 0.5 } } });
    await new TypeSafeJudge({ url: "http://127.0.0.1:8099", backend: "local" }).ask({
      state: "x",
      questions: { refund: QUESTIONS.refund },
    });
    expect(calls[0].url).toBe("http://127.0.0.1:8099/v1/systemone");
    expect((calls[0].init.headers as any).authorization).toBeUndefined();
  });

  test("base URL override keeps the same class on the gateway TypeSafe-compatible API", () => {
    expect(systemOneUrl("https://ai-gateway.vercel.sh/typesafe")).toBe("https://ai-gateway.vercel.sh/typesafe/v1/systemone");
    expect(systemOneUrl("https://api.typesafe.ai/v1/systemone")).toBe("https://api.typesafe.ai/v1/systemone");
    expect(systemOneUrl("http://localhost:9/")).toBe("http://localhost:9/v1/systemone");
  });

  test("missing key is a config JudgeError, no request made", async () => {
    const calls = stubFetch({});
    await expect(new TypeSafeJudge({ requireKey: true }).ask({ state: "x", questions: QUESTIONS })).rejects.toMatchObject({
      name: "JudgeError",
      kind: "config",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("vercel gateway backend", () => {
  test("maps noul -> boolean, parses gateway response and providerMetadata confidence", async () => {
    const calls = stubFetch({
      model: "typesafe-ai/jev",
      answers: {
        route: { type: "choice", choice: "billing", probabilities: { billing: 1, shipping: 0 } },
        refund: { type: "boolean", probability: 0.98 },
        urgency: { type: "score", score: 1.97, probabilities: { "0": 0, "1": 0.02, "2": 0.98 } },
      },
      usage: { inputTokens: 275, outputTokens: 20 },
      providerMetadata: { typesafe: { confidence: { route: 0.91 } }, gateway: { cost: "0.00001155" } },
    });

    const res = await new VercelJudge({ apiKey: "k" }).ask({ state: "charged twice", questions: QUESTIONS });

    expect(calls[0].url).toBe("https://ai-gateway.vercel.sh/v1/evaluate");
    expect((calls[0].init.headers as any).authorization).toBe("Bearer k");
    expect(calls[0].body.model).toBe("typesafe-ai/jev");
    expect(calls[0].body.questions.refund).toEqual({ type: "boolean", instructions: "Is a refund requested?" });
    expect(calls[0].body.questions.route).toEqual(QUESTIONS.route);

    expect(res.backend).toBe("vercel");
    expect(res.answers.refund).toEqual({ type: "noul", probability: 0.98 });
    expect(res.answers.route).toMatchObject({ type: "choice", choice: "billing", confidence: 0.91 });
    expect(res.answers.urgency).toEqual({ type: "score", level: "high", probabilities: { low: 0, medium: 0.02, high: 0.98 } });
    expect(res.usage).toEqual({ inputTokens: 275, outputTokens: 20 });
  });

  test("toGatewayQuestions leaves choice and score untouched", () => {
    expect(toGatewayQuestions(QUESTIONS)).toEqual({
      route: QUESTIONS.route,
      refund: { type: "boolean", instructions: "Is a refund requested?" },
      urgency: QUESTIONS.urgency,
    });
  });

  test("reports customer_verification_required clearly", async () => {
    stubFetch(JSON.stringify({ error: { type: "customer_verification_required", message: "add a card" } }), 402);
    const err = await new VercelJudge({ apiKey: "k" }).ask({ state: "x", questions: QUESTIONS }).catch((e) => e);
    expect(err).toBeInstanceOf(JudgeError);
    expect(err.kind).toBe("http");
    expect(err.status).toBe(402);
    expect(err.message).toContain("customer_verification_required");
    expect(err.message).toContain("payment method");
  });
});

describe("failure modes never return partial answers", () => {
  test("HTTP error", async () => {
    stubFetch("upstream exploded", 500);
    const err = await new VercelJudge({ apiKey: "k" }).ask({ state: "x", questions: QUESTIONS }).catch((e) => e);
    expect(err).toBeInstanceOf(JudgeError);
    expect(err.kind).toBe("http");
    expect(err.status).toBe(500);
  });

  test("non-JSON body", async () => {
    stubFetch("<html>502</html>", 200);
    const err = await new TypeSafeJudge({ apiKey: "k" }).ask({ state: "x", questions: QUESTIONS }).catch((e) => e);
    expect(err.kind).toBe("malformed");
  });

  test("one missing answer fails the whole batch", async () => {
    stubFetch({ answers: { refund: { type: "noul", noul: 0.5 } }, usage: { input_tokens: 1 } });
    const err = await new TypeSafeJudge({ apiKey: "k" }).ask({ state: "x", questions: QUESTIONS }).catch((e) => e);
    expect(err.kind).toBe("malformed");
    expect(err.message).toContain("route");
  });

  test("choice outside the criteria is malformed", async () => {
    stubFetch({ answers: { route: { type: "choice", choice: "legal", probabilities: { legal: 1 } } } });
    const err = await new TypeSafeJudge({ apiKey: "k" }).ask({ state: "x", questions: { route: QUESTIONS.route } }).catch((e) => e);
    expect(err.kind).toBe("malformed");
  });
});

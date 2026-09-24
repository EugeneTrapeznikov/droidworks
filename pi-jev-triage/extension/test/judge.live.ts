// Live Vercel AI Gateway probe. Real money (cents). NOT a *.test.ts, so `bun test` never runs it.
//
//   set -a; source ~/.config/vercel/.env; set +a
//   bun run extension/test/judge.live.ts
//
// Prints numbers only. Fills in the TODOs in src/judge/LIVE.md.
import type { Question } from "../src/judge/types.ts";
import { JudgeError } from "../src/judge/shared.ts";
import { VercelJudge } from "../src/judge/vercel.ts";

import { secret } from "../src/judge/dotenv.ts";
const apiKey = secret("VERCEL_API_KEY") ?? secret("AI_GATEWAY_API_KEY");
if (!apiKey) {
  console.log("VERCEL_API_KEY / AI_GATEWAY_API_KEY not in env; nothing run.");
  process.exit(1);
}
const judge = new VercelJudge({ apiKey, timeoutMs: 30_000 });

const STATE = [
  "user: the search tool returned 40 files, now read src/auth/session.ts and fix the expiry bug",
  "assistant: reading src/auth/session.ts",
  "tool_result(read src/auth/session.ts): 220 lines, exports refreshSession(), SESSION_TTL_MS = 3600000",
].join("\n");

const BATCH: Record<string, Question> = {
  next_tool: {
    type: "choice",
    instructions: "Which tool should the agent call next?",
    criteria: {
      read: "open a specific file whose path is already known",
      grep: "search the repository for an unknown symbol",
      edit: "modify a file whose contents are already in context",
    },
  },
  needs_more_context: { type: "noul", instructions: "Does the agent need to read more files before editing?" },
  result_value: {
    type: "score",
    instructions: "How useful is the last tool result for the stated task?",
    criteria: ["useless", "marginal", "useful", "decisive"],
  },
};

function fail(label: string, e: any): void {
  console.log(`${label} FAILED`, e?.name, e?.kind, e?.status, e?.message);
  if (e instanceof JudgeError && e.detail) console.log("  detail:", e.detail);
}

// 1. batched choice(3) + noul + score
try {
  const r = await judge.ask({ state: STATE, questions: BATCH });
  console.log("== CALL1 batched ==", "latencyMs", r.latencyMs, "usage", JSON.stringify(r.usage));
  console.log(JSON.stringify(r.answers, null, 1));
} catch (e) {
  fail("CALL1", e);
  process.exit(2);
}

// 2. 200-option choice, limits probe
const criteria: Record<string, string> = { read_file: "open a specific file whose path is already known" };
for (let i = 0; i < 199; i++) criteria[`tool_${i}`] = `candidate tool ${i} for ${i % 7 === 0 ? "reading files" : "unrelated work"}`;
try {
  const r = await judge.ask({
    state: STATE,
    questions: { pick: { type: "choice", instructions: "Pick the tool to call next.", criteria } },
  });
  const a = r.answers.pick as Extract<(typeof r.answers)[string], { type: "choice" }>;
  const top = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 3);
  console.log("== CALL2", Object.keys(criteria).length, "options ==", "latencyMs", r.latencyMs, "usage", JSON.stringify(r.usage));
  console.log("choice", a.choice, "confidence", a.confidence, "probs returned", Object.keys(a.probabilities).length, "top3", JSON.stringify(top));
} catch (e) {
  fail("CALL2", e);
}

// 3. latency over 5 batched calls
const lat: number[] = [];
for (let i = 0; i < 5; i++) {
  try {
    lat.push((await judge.ask({ state: STATE, questions: BATCH })).latencyMs);
  } catch (e) {
    fail(`LATENCY[${i}]`, e);
  }
}
const s = [...lat].sort((a, b) => a - b);
console.log("== LATENCY 5x batched ==", JSON.stringify(lat), "p50", s[Math.floor(s.length / 2)], "min", s[0], "max", s[s.length - 1]);

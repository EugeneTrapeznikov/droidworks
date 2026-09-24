#!/usr/bin/env bun
// Tier-2 live arm runner for pi-jev triage.
//
// One `pi -p` call per (arm, prompt) from a fixed scratch fixture repo, with the user's
// normal extensions + skills ON (the full catalog is the thing under test) and an explicit
// `--provider/--model`. Per run we capture first-turn `usage.input`, call count, total input/cacheRead,
// cost and wall clock from the Pi session JSONL, plus the pi-jev DecisionRecords from
// PI_JEV_LOG (extension/src/judge/types.ts).
//
//   bun run.ts --arms off
//   bun run.ts --arms off,triage-local --limit 5
//   bun run.ts --out results/2026-09-23T07-00-00   # resume: existing results are skipped
//
//   bun run.ts --out results/x --arms triage-vercel --ids tool-01,read-02   # rerun selected prompts
//
// Flags: --arms a,b  --limit N  --ids a,b  --out DIR  --concurrency N  --fixture DIR  --no-reset  --list
//        --provider P (default openai-codex)  --model M (default gpt-6-sol); always passed to `pi`

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

const HERE = dirname(new URL(import.meta.url).pathname);
const EXT = join(HERE, "..", "..", "extension", "src", "index.ts");
export const DEFAULT_PROVIDER = "openai-codex";
export const DEFAULT_MODEL = "gpt-6-sol";
const RUN_TIMEOUT_MS = Number(process.env.PI_JEV_BENCH_RUN_TIMEOUT_MS ?? 10 * 60_000);
const DEFAULT_FIXTURE = join(tmpdir(), "pi-jev-live-fixture");

// arm -> env overlay. `off` runs without the extension at all; `triage-<judge>` loads it.
// Everything else in the ambient env (PI_JEV_LOCAL_URL, VERCEL_API_KEY, ...) reaches `pi` through
// the `{...process.env}` spread in `runOne`; only the keys below are forced per arm.
export const ARMS: Record<string, Record<string, string> | null> = { off: null };
for (const judge of ["vercel", "local"] as const) {
  ARMS[`triage-${judge}`] = {
    PI_JEV_FEATURES: "triage",
    PI_JEV_JUDGE: judge,
    PI_JEV_SHADOW: "0",
  };
}

/** The 30-prompt set. `expect_*` / `none` are routing labels from the deferred prefix-diet idea
 *  (root README, Future ideas); triage scoring uses only the prompts. */
export interface RoutingItem {
  id: string;
  prompt: string;
  expect_skills: string[];
  expect_tools: string[];
  none: boolean;
}
export interface RoutingSet {
  version: number;
  base_tools: string[];
  items: RoutingItem[];
}

export interface RunResult {
  arm: string;
  id: string;
  prompt: string;
  provider?: string;
  model?: string;
  ok: boolean;
  exitCode: number;
  wallMs: number;
  firstTurnInput: number | null;
  firstTurnCacheRead: number | null;
  calls: number;
  totalInput: number;
  totalCacheRead: number;
  totalOutput: number;
  cost: number;
  /** tool name -> call count, from the session transcript (`pi_jev_recall` turns, `read` turns, ...) */
  toolCalls: Record<string, number>;
  decisions: unknown[];
  timedOut?: boolean;
  stderrTail?: string;
}

export function loadRoutingSet(path = join(HERE, "routing-set.json")): RoutingSet {
  const set = JSON.parse(readFileSync(path, "utf8")) as RoutingSet;
  validateRoutingSet(set);
  return set;
}

/** Throws on a malformed set. Exported so the tests can assert the schema. */
export function validateRoutingSet(set: RoutingSet): void {
  if (set.version !== 1) throw new Error(`unsupported routing-set version ${set.version}`);
  if (!Array.isArray(set.base_tools) || set.base_tools.length === 0) throw new Error("base_tools missing");
  if (!Array.isArray(set.items)) throw new Error("items missing");
  const seen = new Set<string>();
  for (const it of set.items) {
    const where = `item ${it?.id ?? "<no id>"}`;
    if (!it.id || seen.has(it.id)) throw new Error(`${where}: missing or duplicate id`);
    seen.add(it.id);
    if (typeof it.prompt !== "string" || it.prompt.trim().length < 10) throw new Error(`${where}: bad prompt`);
    if (!Array.isArray(it.expect_skills) || !Array.isArray(it.expect_tools)) throw new Error(`${where}: expect_* must be arrays`);
    if (typeof it.none !== "boolean") throw new Error(`${where}: none must be boolean`);
    const expectsSomething = it.expect_skills.length > 0 || it.expect_tools.length > 0;
    if (it.none === expectsSomething) throw new Error(`${where}: none=${it.none} contradicts expect_* (${expectsSomething ? "non-empty" : "empty"})`);
    for (const t of it.expect_tools) {
      if (set.base_tools.includes(t)) throw new Error(`${where}: expect_tools lists base tool ${t}`);
    }
  }
}

// --- fixture -------------------------------------------------------------
// Embedded so a run reproduces the scratch repo anywhere, including after the
// scratchpad is swept. Files are only written when missing.
const FIXTURE_FILES: Record<string, string> = {
  "README.md": `# widgetsvc\n\nTiny HTTP service that serves widget records from an in-memory store.\n\n- \`src/server.ts\` — HTTP entry point\n- \`src/store.ts\` — the widget store\n- \`src/util.ts\`  — helpers\n- \`docs/notes.md\` — design notes\n`,
  "package.json": `{ "name": "widgetsvc", "version": "0.1.0", "type": "module" }\n`,
  "src/server.ts": `import { WidgetStore } from "./store.ts";
import { parseLimit } from "./util.ts";

const store = new WidgetStore();

export function handle(req: { url: string }): Response {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/widgets") {
    const limit = parseLimit(u.searchParams.get("limit"));
    return Response.json(store.list(limit));
  }
  if (u.pathname.startsWith("/widgets/")) {
    const w = store.get(u.pathname.slice("/widgets/".length));
    return w ? Response.json(w) : new Response("not found", { status: 404 });
  }
  return new Response("not found", { status: 404 });
}
`,
  "src/store.ts": `export interface Widget { id: string; name: string; qty: number; }

export class WidgetStore {
  private items = new Map<string, Widget>();

  constructor() {
    this.items.set("a1", { id: "a1", name: "sprocket", qty: 3 });
    this.items.set("b2", { id: "b2", name: "flange", qty: 0 });
  }

  get(id: string): Widget | undefined {
    return this.items.get(id);
  }

  list(limit: number): Widget[] {
    return [...this.items.values()].slice(0, limit);
  }

  // BUG: does not validate qty, negative quantities are accepted
  add(w: Widget): void {
    this.items.set(w.id, w);
  }
}
`,
  "src/util.ts": `export function parseLimit(raw: string | null): number {
  const n = Number(raw ?? "10");
  return Number.isFinite(n) ? n : 10;
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
`,
  "docs/notes.md": `# Design notes\n\nThe store is in-memory on purpose; persistence is out of scope.\n\`parseLimit\` clamps nothing today — a caller can ask for a negative limit.\n`,
};

/**
 * Materialize the fixture. `reset` wipes first: prompts edit files and create `.pi/schedule-prompts.json`
 * in the cwd, so without a reset one arm's side effects leak into the next. Runs share the cwd
 * (concurrency > 1), so reset happens once per invocation, not per run.
 */
export function ensureFixture(dir: string, reset = false): string {
  if (reset) rmSync(dir, { recursive: true, force: true });
  for (const [rel, body] of Object.entries(FIXTURE_FILES)) {
    const p = join(dir, rel);
    if (existsSync(p)) continue;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return dir;
}

// --- session parsing -----------------------------------------------------
export interface SessionUsage {
  firstTurnInput: number | null;
  /**
   * The provider caches prefixes implicitly ACROSS sessions, so a `pi -p` first turn is only
   * sometimes a cold miss. `firstTurnInput + firstTurnCacheRead` is the prefix size; billed
   * `firstTurnInput` alone is not comparable between runs.
   */
  firstTurnCacheRead: number | null;
  calls: number;
  totalInput: number;
  totalCacheRead: number;
  totalOutput: number;
  cost: number;
  /** tool name -> call count, from `{type:"toolCall", name}` parts of assistant messages. */
  toolCalls: Record<string, number>;
  /** `[pi-jev: hid lines` stubs in tool results the model actually saw (0 in shadow mode). */
  stubs: number;
}

/** Sum `message.usage` across the top-level session JSONL. Subdirectories (moa advisor logs) are ignored. */
export function parseSession(sessionDir: string): SessionUsage {
  const out: SessionUsage = { firstTurnInput: null, firstTurnCacheRead: null, calls: 0, totalInput: 0, totalCacheRead: 0, totalOutput: 0, cost: 0, toolCalls: {}, stubs: 0 };
  if (!existsSync(sessionDir)) return out;
  for (const name of readdirSync(sessionDir)) {
    if (!name.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(sessionDir, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let rec: any;
      try { rec = JSON.parse(line); } catch { continue; }
      const content = rec?.message?.content;
      if (Array.isArray(content)) {
        if (rec.message.role === "toolResult") {
          for (const p of content) if (typeof p?.text === "string") out.stubs += p.text.split("[pi-jev: hid lines").length - 1;
        }
        for (const p of content) {
          if (p?.type !== "toolCall" || typeof p.name !== "string") continue;
          out.toolCalls[p.name] = (out.toolCalls[p.name] ?? 0) + 1;
        }
      }
      const u = rec?.message?.usage ?? rec?.usage;
      if (!u || typeof u.input !== "number") continue;
      out.calls++;
      if (out.firstTurnInput === null) {
        out.firstTurnInput = u.input;
        out.firstTurnCacheRead = u.cacheRead ?? 0;
      }
      out.totalInput += u.input ?? 0;
      out.totalCacheRead += u.cacheRead ?? 0;
      out.totalOutput += u.output ?? 0;
      out.cost += u.cost?.total ?? 0;
    }
  }
  return out;
}

export function readDecisions(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(l => l.trim())
    .flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
}

// --- runner --------------------------------------------------------------
export interface Model { provider: string; model: string }

export function piArgs(sessionDir: string, m: Model, withExt: boolean, prompt: string): string[] {
  const args = ["-p", "--session-dir", sessionDir, "--no-context-files", "--provider", m.provider, "--model", m.model];
  if (withExt) args.push("-e", EXT);
  args.push(prompt);
  return args;
}

async function runOne(arm: string, item: RoutingItem, outDir: string, fixture: string, m: Model): Promise<RunResult> {
  const resultPath = join(outDir, arm, `${item.id}.json`);
  if (existsSync(resultPath)) return JSON.parse(readFileSync(resultPath, "utf8"));

  const sessionDir = join(outDir, arm, `${item.id}.session`);
  const jevLog = join(outDir, arm, `${item.id}.jev.jsonl`);
  mkdirSync(join(outDir, arm), { recursive: true });

  const env: NodeJS.ProcessEnv = { ...process.env, PI_JEV_LOG: jevLog };
  const overlay = ARMS[arm];
  const args = piArgs(sessionDir, m, !!overlay, item.prompt);
  if (overlay) {
    Object.assign(env, overlay);
  } else {
    for (const k of Object.keys(process.env)) if (k.startsWith("PI_JEV_")) delete env[k];
    env.PI_JEV_LOG = jevLog;
  }

  const t0 = Date.now();
  const { code, stderr, timedOut } = await new Promise<{ code: number; stderr: string; timedOut: boolean }>(done => {
    // stdin must be "ignore": `pi -p --session-dir` hangs waiting on a piped stdin
    const ch = spawn("pi", args, { cwd: fixture, env, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    let timedOut = false;
    ch.stdout.on("data", () => {});
    ch.stderr.on("data", d => { err += d; });
    const kill = setTimeout(() => { timedOut = true; ch.kill("SIGKILL"); }, RUN_TIMEOUT_MS);
    ch.on("close", c => { clearTimeout(kill); done({ code: c ?? -1, stderr: err, timedOut }); });
  });
  const wallMs = Date.now() - t0;

  const usage = parseSession(sessionDir);
  const result: RunResult = {
    arm,
    id: item.id,
    prompt: item.prompt,
    provider: m.provider,
    model: m.model,
    // a run that reached the model still carries a usable prefix measurement, even if it later hung
    ok: usage.calls > 0,
    exitCode: code,
    timedOut,
    wallMs,
    ...usage,
    decisions: readDecisions(jevLog),
    stderrTail: code === 0 ? undefined : stderr.slice(-800),
  };
  writeFileSync(resultPath, JSON.stringify(result, null, 2));
  return result;
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

if (import.meta.main) {
  if (process.argv.includes("--list")) {
    console.log(Object.keys(ARMS).join("\n"));
    process.exit(0);
  }
  const set = loadRoutingSet();
  const limit = Number(flag("limit", String(set.items.length)));
  const ids = flag("ids")?.split(",").map(s => s.trim()).filter(Boolean);
  const items = ids ? set.items.filter(it => ids.includes(it.id)) : set.items.slice(0, limit);
  if (ids && items.length !== ids.length) throw new Error(`unknown id in --ids ${ids.join(",")}`);
  const model: Model = { provider: flag("provider", DEFAULT_PROVIDER) as string, model: flag("model", DEFAULT_MODEL) as string };
  const arms = (flag("arms", "off") as string).split(",").map(s => s.trim()).filter(Boolean);
  for (const a of arms) if (!(a in ARMS)) throw new Error(`unknown arm ${a}; known: ${Object.keys(ARMS).join(", ")}`);
  // absolute: pi runs with cwd=fixture and would otherwise resolve --session-dir against it
  const outDir = resolve(flag("out") ?? join(HERE, "results", new Date().toISOString().replace(/[:.]/g, "-")));
  const concurrency = Number(flag("concurrency", "3"));
  const fixture = ensureFixture(resolve(flag("fixture", DEFAULT_FIXTURE) as string), !process.argv.includes("--no-reset"));

  mkdirSync(outDir, { recursive: true });
  console.error(`arms=${arms.join(",")} items=${items.length} out=${outDir} cwd=${fixture} conc=${concurrency} model=${model.provider}/${model.model}`);

  const jobs = arms.flatMap(arm => items.map(item => ({ arm, item })));
  let done = 0;
  await pool(jobs, concurrency, async ({ arm, item }) => {
    const r = await runOne(arm, item, outDir, fixture, model);
    done++;
    console.error(
      `[${done}/${jobs.length}] ${arm}/${item.id} ${r.ok ? "ok" : `FAIL(${r.exitCode})`} ` +
      `first=${r.firstTurnInput} calls=${r.calls} cost=$${r.cost.toFixed(4)} ${(r.wallMs / 1000).toFixed(1)}s`,
    );
  });
  console.error(`done -> ${outDir}\nscore: bun ${join(HERE, "score.ts")} --in ${outDir}`);
}

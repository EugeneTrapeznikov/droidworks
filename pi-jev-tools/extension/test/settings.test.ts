import { describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/telemetry.ts";
import { readSettings, type JevSettings } from "../src/settings.ts";
import { QUESTION_SETS, RECALL_NOTE, RECALL_SECTION, loadTriageConfig } from "../src/triage/core.ts";
import { MockJudge } from "../src/judge/index.ts";

// typebox ships with Pi, not with this repo; the recall tool schema is irrelevant here.
mock.module("typebox", () => ({ Type: new Proxy({}, { get: () => () => ({}) }) }));
const { register } = await import("../src/triage/index.ts");

const env = (e: Record<string, string> = {}) => e as NodeJS.ProcessEnv;
const agentDir = (content?: string) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-jev-settings-"));
	if (content !== undefined) writeFileSync(join(dir, "settings.json"), content);
	return dir;
};

describe("settings.json precedence: env > settings > default", () => {
	const s: JevSettings = {
		judge: "typesafe",
		questionSet: "sharpened",
		timeoutMs: 5000,
		shadow: false,
		triage: { tools: ["read", "bash"], minChars: 500, drop: 0.2 },
		stateChars: { typesafe: 40_000 },
	};

	test("defaults with no settings", () => {
		const c = loadConfig(env(), {});
		const t = loadTriageConfig(env(), {});
		expect([c.judge, c.shadow, c.timeoutMs]).toEqual(["vercel", true, 15_000]);
		expect([t.minChars, t.stateCap, t.questions]).toEqual([2000, 80_000, QUESTION_SETS.winnow]);
	});

	test("settings override defaults", () => {
		const c = loadConfig(env(), s);
		const t = loadTriageConfig(env(), s);
		expect([c.judge, c.shadow, c.timeoutMs]).toEqual(["typesafe", false, 5000]);
		expect(t.tools).toEqual(["read", "bash"]);
		expect([t.minChars, t.drop, t.keep, t.stateCap]).toEqual([500, 0.2, 0.5, 40_000]);
		expect(t.questions).toBe(QUESTION_SETS.sharpened);
	});

	test("env overrides settings", () => {
		const e = env({
			PI_JEV_JUDGE: "vercel",
			PI_JEV_SHADOW: "1",
			PI_JEV_TIMEOUT_MS: "900",
			PI_JEV_TRIAGE_TOOLS: "grep",
			PI_JEV_TRIAGE_MIN_CHARS: "3000",
			PI_JEV_STATE_CHARS: "1234",
			PI_JEV_QUESTION_SET: "winnow",
		});
		const c = loadConfig(e, s);
		const t = loadTriageConfig(e, s);
		expect([c.judge, c.shadow, c.timeoutMs]).toEqual(["vercel", true, 900]);
		expect([t.tools, t.minChars, t.stateCap]).toEqual([["grep"], 3000, 1234]);
		expect(t.questions).toBe(QUESTION_SETS.winnow);
	});

	test("backend-keyed stateChars applies to the code-default judge", () => {
		expect(loadTriageConfig(env({ PI_JEV_JUDGE: "local" }), { stateChars: { local: 20_000 } }).stateCap).toBe(20_000);
	});
});

describe("named judges", () => {
	const s: JevSettings = {
		judge: "kev",
		judges: {
			kev: { url: "http://127.0.0.1:47411", stateChars: 24_000 },
			jevk5: { url: "http://127.0.0.1:47412", stateChars: 24_000 },
		},
		stateChars: { jevk5: 12_000 },
	};

	test("selecting a name resolves backend local, url, and cap", () => {
		const c = loadConfig(env(), s);
		expect([c.judge, c.localUrl]).toEqual(["local", "http://127.0.0.1:47411"]);
		expect(loadTriageConfig(env(), s).stateCap).toBe(24_000);
	});

	test("PI_JEV_JUDGE picks a named judge; its own stateChars beats the top-level map", () => {
		const e = env({ PI_JEV_JUDGE: "jevk5" });
		expect(loadConfig(e, s).localUrl).toBe("http://127.0.0.1:47412");
		expect(loadTriageConfig(e, s).stateCap).toBe(24_000);
	});

	test("PI_JEV_LOCAL_URL and PI_JEV_STATE_CHARS still win", () => {
		const e = env({ PI_JEV_LOCAL_URL: "http://127.0.0.1:1", PI_JEV_STATE_CHARS: "12000" });
		expect(loadConfig(e, s).localUrl).toBe("http://127.0.0.1:1");
		expect(loadTriageConfig(e, s).stateCap).toBe(12_000);
	});

	test("named judge without its own cap falls back to the local default", () => {
		expect(loadTriageConfig(env(), { judge: "x", judges: { x: { url: "http://h" } } }).stateCap).toBe(24_000);
	});
});

describe("readSettings", () => {
	test("reads the pi-jev block from PI_CODING_AGENT_DIR/settings.json", () => {
		const dir = agentDir(JSON.stringify({ theme: "dark", "pi-jev": { judge: "kev" } }));
		expect(readSettings(env({ PI_CODING_AGENT_DIR: dir }))).toEqual({ judge: "kev" });
	});

	test("missing file or key yields {}", () => {
		expect(readSettings(env({ PI_CODING_AGENT_DIR: agentDir() }))).toEqual({});
		expect(readSettings(env({ PI_CODING_AGENT_DIR: agentDir("{}") }))).toEqual({});
	});

	test("invalid JSON or non-object block falls back to defaults and warns once", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		const bad = env({ PI_CODING_AGENT_DIR: agentDir("{ not json") });
		expect(readSettings(bad)).toEqual({});
		expect(readSettings(env({ PI_CODING_AGENT_DIR: agentDir('{"pi-jev": 3}') }))).toEqual({});
		expect(loadConfig(bad).judge).toBe("vercel");
		expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
		warn.mockRestore();
	});
});

describe("recall note in the system prompt", () => {
	const fakePi = () => {
		const handlers: Record<string, Function[]> = {};
		return {
			handlers,
			on: (name: string, fn: Function) => (handlers[name] ??= []).push(fn),
			registerTool: () => {},
		};
	};
	const cfg = (shadow: boolean) => ({ ...loadConfig(env(), {}), shadow });

	test("active triage sets one stable section in place and returns nothing", () => {
		const pi = fakePi();
		register(pi, new MockJudge(), cfg(false));
		expect(pi.handlers.before_agent_start).toHaveLength(1);
		const [h] = pi.handlers.before_agent_start;
		const opts = { sections: { other: "x" } as Record<string, string> };
		const sectionsRef = opts.sections;
		expect(h({ systemPromptOptions: opts })).toBeUndefined();
		expect(h({ systemPromptOptions: opts })).toBeUndefined();
		expect(opts.sections).toBe(sectionsRef);
		expect(Object.keys(opts.sections)).toEqual(["other", RECALL_SECTION]);
		expect(opts.sections[RECALL_SECTION]).toBe(RECALL_NOTE);
		expect(RECALL_NOTE).toContain("pi_jev_recall(key, start, end)");
	});

	test("shadow mode adds no section", () => {
		const pi = fakePi();
		register(pi, new MockJudge(), cfg(true));
		expect(pi.handlers.before_agent_start).toBeUndefined();
	});
});

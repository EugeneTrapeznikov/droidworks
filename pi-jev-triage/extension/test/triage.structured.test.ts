import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JevConfig, Judge } from "../src/judge/types.ts";
import { detectStructured, loadTriageConfig, makeHandler } from "../src/triage/core.ts";

// Real `git diff` output from this repo.
const GIT_DIFF = `diff --git a/pi-jev-triage/extension/src/settings.ts b/pi-jev-triage/extension/src/settings.ts
index b93f982..a7f3ad7 100644
--- a/pi-jev-triage/extension/src/settings.ts
+++ b/pi-jev-triage/extension/src/settings.ts
@@ -22,6 +22,7 @@ export interface JevSettings {
 		drop?: number;
 		keep?: number;
 		minPruneRatio?: number;
+		skipStructured?: boolean;
 	};
 }
 `;

// Real `git show --stat` output from this repo (commit e83367f), trimmed.
const GIT_SHOW = `commit e83367f8543a7a6995fcc1809a0c6255b664ab8b
Author: A U Thor <author@example.com>
Date:   Wed Sep 23 10:34:23 2026 -0700

    docs(pi-jev-triage): add README, research notes, and session-mining scripts
---
 pi-jev-triage/README.md | 121 +++++++++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 121 insertions(+)

diff --git a/pi-jev-triage/README.md b/pi-jev-triage/README.md
new file mode 100644
index 0000000..a947a29
--- /dev/null
+++ b/pi-jev-triage/README.md
@@ -0,0 +1,121 @@
+# Pi JEV Triage
+`;

const PRETTY_JSON = JSON.stringify({ name: "pi-jev", version: "0.1.0", scripts: { test: "bun test" }, tags: ["a", "b"] }, null, 2);
const MINIFIED_ARRAY = JSON.stringify([{ id: 1, ok: true }, { id: 2, ok: false, note: null }]);
const JSONL = [{ ts: 1, event: "start" }, { ts: 2, event: "stop" }, [1, 2, 3]].map((r) => JSON.stringify(r)).join("\n") + "\n";

const TS_FILE = `{
  "name": "defaults"
}
export const config = {
  name: "defaults",
  retries: 3,
};
export function load() {
  return config;
}`;
const LOG = `2026-09-23T10:00:01Z INFO server started on :8080
2026-09-23T10:00:02Z WARN user@@host login retry @@ -1 +1 @@ not a hunk
2026-09-23T10:00:03Z INFO request done in 12ms`;
const MARKDOWN = `# Pi JEV Triage

[Design](#design) is below.

- one tool_result hook
- recall stubs`;
const PYTHON = `import json


def load(path):
    """Read a config file."""
    with open(path) as f:
        return json.load(f)
`;
const GREP = `src/triage/core.ts:12:import { record } from "../telemetry.ts";
src/triage/core.ts:40:	const tools = env.PI_JEV_TRIAGE_TOOLS ?? "read";
src/settings.ts:5:import { join } from "node:path";`;

describe("detectStructured", () => {
	test.each([
		["git diff", GIT_DIFF, "diff"],
		["git show", GIT_SHOW, "diff"],
		["diff -u", "--- a.txt\t2026-09-23\n+++ b.txt\t2026-09-23\n@@ -1 +1 @@\n-a\n+b\n", "diff"],
		["bare hunk", "@@ -1,2 +1,2 @@\n-a\n+b\n c\n", "diff"],
		["ANSI-coloured diff", `\x1b[1mdiff --git a/x b/x\x1b[m\n`, "diff"],
		["pretty JSON object", PRETTY_JSON, "json"],
		["minified JSON array", MINIFIED_ARRAY, "json"],
		["JSONL", JSONL, "json"],
		["JSON with a trailing comma", `{\n  "a": 1,\n  "b": [1, 2],\n}`, "json"],
	])("%s -> %s", (_, text, kind) => expect(detectStructured(text)).toBe(kind as "diff" | "json"));

	test.each([
		["TypeScript file opening with {", TS_FILE],
		["log with a stray @@", LOG],
		["markdown", MARKDOWN],
		["Python file", PYTHON],
		["grep result", GREP],
		["seq output (bare JSON scalars)", "1\n2\n3\n"],
	])("%s -> null", (_, text) => expect(detectStructured(text)).toBeNull());
});

describe("handler skip_structured", () => {
	const cfg = (): JevConfig => ({
		judge: "mock",
		shadow: false,
		features: new Set(["triage"]) as JevConfig["features"],
		logPath: join(mkdtempSync(join(tmpdir(), "pi-jev-log-")), "decisions.jsonl"),
		timeoutMs: 750,
	});
	const tcfg = (env: Record<string, string> = {}) => ({
		...loadTriageConfig(env as NodeJS.ProcessEnv, {}),
		cacheDir: mkdtempSync(join(tmpdir(), "pi-jev-")),
	});
	let asked = 0;
	const dropMiddle: Judge = {
		name: "mock",
		async ask(req) {
			asked++;
			const answers: Record<string, any> = {};
			for (const id of Object.keys(req.questions)) answers[id] = { type: "noul", probability: 0 };
			return { answers, latencyMs: 1, backend: "mock" };
		},
	};
	const ev = (text: string) => ({ toolName: "bash", toolCallId: "c1", input: {}, content: [{ type: "text", text }] });
	const ctx = { sessionManager: { getBranch: () => [] } };
	const log = (c: JevConfig) => readFileSync(c.logPath!, "utf-8").trim().split("\n").map((l) => JSON.parse(l));

	const bigDiff = GIT_DIFF + Array.from({ length: 200 }, (_, i) => `+\tline ${i};`).join("\n");
	const bigSource = Array.from({ length: 200 }, (_, i) => `export const v${i} = ${i}; // padding padding`).join("\n");

	test("a diff passes through untouched, logged skip_structured, judge never asked", async () => {
		const c = cfg();
		asked = 0;
		expect(await makeHandler(dropMiddle, c, tcfg())(ev(bigDiff), ctx)).toBeUndefined();
		expect(asked).toBe(0);
		expect(log(c)[0].detail).toMatchObject({ outcome: "skip_structured", structured: "diff", bytesAfter: bigDiff.length });
	});

	test("a source file is still triaged", async () => {
		const c = cfg();
		const out = await makeHandler(dropMiddle, c, tcfg())(ev(bigSource), ctx);
		expect(out!.content[0].text).toContain("[pi-jev: hid lines");
		expect(log(c)[0].detail.outcome).toBe("pruned");
	});

	test("PI_JEV_SKIP_STRUCTURED=0 triages the diff", async () => {
		const c = cfg();
		expect(await makeHandler(dropMiddle, c, tcfg({ PI_JEV_SKIP_STRUCTURED: "0" }))(ev(bigDiff), ctx)).toBeDefined();
		expect(log(c)[0].detail.outcome).toBe("pruned");
	});

	test("settings triage.skipStructured=false disables the guard; env wins over it", () => {
		expect(loadTriageConfig({} as NodeJS.ProcessEnv, {}).skipStructured).toBe(true);
		expect(loadTriageConfig({} as NodeJS.ProcessEnv, { triage: { skipStructured: false } }).skipStructured).toBe(false);
		expect(loadTriageConfig({ PI_JEV_SKIP_STRUCTURED: "1" } as NodeJS.ProcessEnv, { triage: { skipStructured: false } }).skipStructured).toBe(true);
	});
});

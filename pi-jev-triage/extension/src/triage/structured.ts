// Single structural units that a recall stub would corrupt: a hole in a unified diff or a JSON
// body leaves output the agent (or `git apply`, `jq`) cannot use. Triage skips these. Whole-file
// reads, logs, test output, grep hits, listings, and fetched pages are not detected here.

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const HUNK = /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/;
/** A bare word followed by another word: prose ("The build") or code ("export const"). JSON lines
 *  start with a quote, bracket, digit, or a literal followed by punctuation. */
const PROSE = /^\s*[A-Za-z_$][\w$]*\s+[A-Za-z_$]/;

const parses = (s: string) => {
	try {
		JSON.parse(s);
		return true;
	} catch {
		return false;
	}
};

export type StructuredKind = "diff" | "json";

export function detectStructured(text: string): StructuredKind | null {
	const t = text.replace(ANSI, "").trim();
	const lines = t.split("\n");
	const head = lines.filter((l) => l.trim()).slice(0, 3);

	// unified diff: `git diff`, `diff -u`, a bare hunk, or `git show` / `git log -p`
	if (t.startsWith("diff --git ")) return "diff";
	if (t.startsWith("--- ") && lines[1]?.startsWith("+++ ")) return "diff";
	if (head.some((l) => HUNK.test(l))) return "diff";
	if (/^commit [0-9a-f]{7,40}\b/.test(t) && /^diff --git /m.test(t)) return "diff";

	// JSON body: parses whole, or bracket-balanced with no prose/code lines (comments, trailing commas)
	const open = t[0];
	if (open === "{" || open === "[") {
		if (parses(t)) return "json";
		if (t.at(-1) === (open === "{" ? "}" : "]") && !lines.some((l) => PROSE.test(l))) return "json";
	}
	// JSONL: every non-empty line is a JSON object or array
	const rows = lines.filter((l) => l.trim());
	if (rows.length > 1 && rows.every((l) => /^\s*[[{]/.test(l) && parses(l))) return "json";
	return null;
}

import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfiles, resolveProfile, type ProfilesFile } from "./index.ts";

const file: ProfilesFile = {
	default: "personal",
	profiles: {
		work: { match: [{ git_remote_includes: "corp.example" }, { cwd_prefix: "/tmp/work" }] },
		personal: {},
	},
};

test("remote or path rule selects the first matching profile", () => {
	expect(resolveProfile(file, "/anywhere", () => "git@corp.example:team/repo.git")).toBe("work");
	expect(resolveProfile(file, "/tmp/work/repo", () => "")).toBe("work");
});

test("path prefix is segment-safe and unmatched falls back to default", () => {
	expect(resolveProfile(file, "/tmp/workshop", () => "git@github.com:me/x.git")).toBe("personal");
	expect(resolveProfile({ profiles: file.profiles }, "/elsewhere", () => "")).toBeUndefined();
});

test("a rule with no conditions never matches", () => {
	expect(resolveProfile({ profiles: { any: { match: [{}] } } }, "/x", () => "")).toBeUndefined();
});

test("missing file is no profile; malformed file throws", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-profiles-"));
	expect(loadProfiles(join(dir, "none.json"))).toBeUndefined();
	writeFileSync(join(dir, "bad.yaml"), "profiles: []\n");
	expect(() => loadProfiles(join(dir, "bad.yaml"))).toThrow();
	writeFileSync(join(dir, "null.yaml"), "profiles:\n");
	expect(() => loadProfiles(join(dir, "null.yaml"))).toThrow();
	writeFileSync(join(dir, "ok.yaml"), "default: personal\nprofiles:\n  work:\n    match: [{ cwd_prefix: /tmp/work }]\n  personal: {}\n");
	expect(resolveProfile(loadProfiles(join(dir, "ok.yaml"))!, "/tmp/work/x", () => "")).toBe("work");
	writeFileSync(join(dir, "legacy.json"), JSON.stringify(file));
	expect(loadProfiles(join(dir, "legacy.json"))?.default).toBe("personal");
});

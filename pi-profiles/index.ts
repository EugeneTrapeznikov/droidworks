// Pi Profiles: pick a profile for the session's repo from one private file, then push
// its settings into the session. Consumers never see profiles: they receive their own
// key from `config` on the generic `pi-config-overlay:v1` event bus channel.
//
// ~/.config/agent-profiles/profiles.yaml (or $AGENT_PROFILES_PATH; JSON is valid YAML):
//   default: personal
//   profiles:
//     work:
//       match: [{ git_remote_includes: "…" }, { cwd_prefix: "~/…" }]
//       pi: { model: provider/id, config: { <extension-id>: { … } } }
//     personal:
//       pi:
//         providers: { <provider-id>: { baseUrl: http://127.0.0.1:8787/… } }
//         mcp: { <server>: { command: …, args: [ … ] } }   # needs pi-mcp-adapter
//
// First profile with any matching rule wins; otherwise `default`. No file = no push.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parse as parseYaml } from "yaml";

export const CONFIG_OVERLAY_CHANNEL = "pi-config-overlay:v1";
const MCP_RUNTIME_REGISTER_EVENT = "pi-mcp-adapter:runtime-register:v1";

type Registration = { dispose(): Promise<void> };
type RegisterRequest = { version: 1; name: string; definition: unknown; result?: { ok: true; registration: Registration } | { ok: false; error: Error } };

/** Register each server with pi-mcp-adapter; returns the registrations and the failures. */
export function registerMcp(pi: Pick<ExtensionAPI, "events">, servers: Record<string, unknown>): { registered: Registration[]; failed: string[] } {
	const registered: Registration[] = [], failed: string[] = [];
	for (const [name, definition] of Object.entries(servers)) {
		const request: RegisterRequest = { version: 1, name, definition };
		pi.events.emit(MCP_RUNTIME_REGISTER_EVENT, request);
		if (request.result?.ok) registered.push(request.result.registration);
		else failed.push(`${name}: ${request.result ? request.result.error.message : "pi-mcp-adapter not loaded"}`);
	}
	return { registered, failed };
}

export interface Match { cwd_prefix?: string; git_remote_includes?: string }
export interface ProviderOverride { baseUrl?: string; headers?: Record<string, string> }
export interface Profile {
	match?: Match[];
	pi?: {
		model?: string;
		config?: Record<string, unknown>;
		providers?: Record<string, ProviderOverride>;
		/** MCP server definitions registered with pi-mcp-adapter for the session. */
		mcp?: Record<string, Record<string, unknown>>;
	};
}
export interface ProfilesFile { default?: string; profiles: Record<string, Profile> }

const profilesPath = () => process.env.AGENT_PROFILES_PATH || join(homedir(), ".config/agent-profiles/profiles.yaml");

function canonical(path: string): string {
	const abs = resolve(path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
	try { return realpathSync(abs); } catch { return abs; }
}

function gitRemote(cwd: string): string {
	try {
		return execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], { timeout: 1000, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
	} catch { return ""; }
}

/** A rule matches when every condition it states holds; a rule with no conditions never matches. */
function matches(rule: Match, cwd: string, remote: () => string): boolean {
	if (!rule.cwd_prefix && !rule.git_remote_includes) return false;
	if (rule.cwd_prefix) {
		const actual = canonical(cwd), prefix = canonical(rule.cwd_prefix);
		if (actual !== prefix && !actual.startsWith(prefix.endsWith(sep) ? prefix : prefix + sep)) return false;
	}
	return !rule.git_remote_includes || remote().includes(rule.git_remote_includes);
}

export function resolveProfile(file: ProfilesFile, cwd: string, remote: () => string = () => gitRemote(cwd)): string | undefined {
	let cached: string | undefined;
	const once = () => (cached ??= remote());
	for (const [name, profile] of Object.entries(file.profiles)) {
		if ((profile.match ?? []).some((rule) => matches(rule, cwd, once))) return name;
	}
	return file.default && file.profiles[file.default] ? file.default : undefined;
}

/** Missing file → undefined. Malformed file throws. */
export function loadProfiles(path = profilesPath()): ProfilesFile | undefined {
	let text: string;
	try { text = readFileSync(path, "utf8"); } catch (e: any) { if (e?.code === "ENOENT") return undefined; throw e; }
	const file = parseYaml(text);
	if (!file?.profiles || typeof file.profiles !== "object" || Array.isArray(file.profiles)) throw new Error(`${path}: "profiles" object required`);
	return file;
}

/** True when `url`'s host:port accepts a TCP connection within `timeoutMs`. */
export function reachable(url: string, timeoutMs = 500): Promise<boolean> {
	let host: string, port: number;
	try {
		const u = new URL(url);
		host = u.hostname;
		port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
	} catch { return Promise.resolve(false); }
	return new Promise((done) => {
		const socket = connect({ host, port });
		const finish = (ok: boolean) => { socket.destroy(); done(ok); };
		socket.setTimeout(timeoutMs, () => finish(false));
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

/** --model/--provider on the command line beats the profile. */
const cliPicksModel = () => process.argv.some((a) => /^--(model|provider|models)(=|$)/.test(a));

export default async function piProfiles(pi: ExtensionAPI): Promise<void> {
	// Provider overrides must be registered in the factory to reach startup model selection, so they
	// resolve against the launch directory. A target that does not accept connections is skipped, so a
	// stopped local proxy never breaks the session.
	// ponytail: resolves process.cwd(), not a resumed session's cwd; re-resolve per session if that matters.
	const skipped: string[] = [];
	try {
		const file = loadProfiles();
		const name = file && resolveProfile(file, process.cwd());
		for (const [id, override] of Object.entries((name && file!.profiles[name]?.pi?.providers) || {})) {
			if (override?.baseUrl && !(await reachable(override.baseUrl))) { skipped.push(`${id} → ${override.baseUrl}`); continue; }
			pi.registerProvider(id, override as any);
		}
	} catch { /* reported by session_start */ }

	let mcpRegistrations: Registration[] = [];
	const disposeMcp = async () => {
		const current = mcpRegistrations;
		mcpRegistrations = [];
		await Promise.allSettled(current.map((r) => r.dispose()));
	};
	pi.on("session_shutdown", disposeMcp);

	pi.on("session_start", async (event, ctx) => {
		if (skipped.length && ctx.hasUI) ctx.ui.notify(`pi-profiles: unreachable, using default endpoint: ${skipped.join(", ")}`, "warning");
		await disposeMcp();
		let file: ProfilesFile | undefined;
		try { file = loadProfiles(); } catch (e: any) {
			if (ctx.hasUI) ctx.ui.notify(`pi-profiles: ${e?.message ?? e}; no profile applied`, "error");
			return;
		}
		if (!file) return;
		const name = resolveProfile(file, ctx.cwd);
		const profile = name ? file.profiles[name] : undefined;
		process.env.AGENT_PROFILE = name ?? "";
		pi.events.emit(CONFIG_OVERLAY_CHANNEL, { source: "pi-profiles", profile: name ?? null, config: profile?.pi?.config ?? {} });
		if (ctx.hasUI) ctx.ui.setStatus("pi-profiles", name ? `👤 profile:${name}` : undefined);

		const mcp = registerMcp(pi, profile?.pi?.mcp ?? {});
		mcpRegistrations = mcp.registered;
		if (mcp.failed.length && ctx.hasUI) ctx.ui.notify(`pi-profiles: MCP not registered: ${mcp.failed.join("; ")}`, "warning");

		const model = profile?.pi?.model;
		// Only fresh sessions: a resumed/forked session keeps the model it was using.
		if (model && (event.reason === "startup" || event.reason === "new") && !cliPicksModel()) {
			const slash = model.indexOf("/");
			const found = slash > 0 ? ctx.modelRegistry.find(model.slice(0, slash), model.slice(slash + 1)) : undefined;
			if (!found) { if (ctx.hasUI) ctx.ui.notify(`pi-profiles: model ${model} not found`, "warning"); }
			else if (ctx.model?.provider !== found.provider || ctx.model?.id !== found.id) await pi.setModel(found);
		}
	});
}

// `bun index.ts [cwd]` prints the profile for cwd, for shells and other agents.
if (import.meta.main) {
	const file = loadProfiles();
	console.log((file && resolveProfile(file, process.argv[2] || process.cwd())) || "");
}

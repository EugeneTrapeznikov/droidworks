// The "pi-jev" block of Pi's settings.json. Pi has no extension-settings API, so this reads the file
// directly (as pi-observational-memory does). Precedence everywhere: PI_JEV_* env > settings > code default.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { secret } from "./judge/dotenv.ts";

export interface JevSettings {
	judge?: string;
	questionSet?: string;
	timeoutMs?: number;
	shadow?: boolean;
	/** Judged-state cap keyed by judge name (or backend: vercel, typesafe, local). */
	stateChars?: Record<string, number>;
	localUrl?: string;
	/** Named local judges; `judge: "<name>"` selects one. Anything with a `url` runs as backend `local`.
	 *  `drop`/`keep` override `triage.drop`/`triage.keep`; `maxBlocksPerCall` chunks the judge call. */
	judges?: Record<string, { url?: string; stateChars?: number; drop?: number; keep?: number; maxBlocksPerCall?: number }>;
	triage?: {
		tools?: string[];
		minChars?: number;
		blockLines?: number;
		blockChars?: number;
		drop?: number;
		keep?: number;
		minPruneRatio?: number;
		skipStructured?: boolean;
	};
}

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
let warned = false;

/** Pi's own agent dir rule: `PI_CODING_AGENT_DIR`, else `~/.pi/agent`. Missing file or key = `{}`; a
 *  malformed file logs once and yields `{}` so the extension runs on defaults. */
export function readSettings(env: NodeJS.ProcessEnv = process.env): JevSettings {
	const path = join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "settings.json");
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch {
		return {};
	}
	try {
		const block = JSON.parse(text)?.["pi-jev"];
		if (block === undefined) return {};
		if (!isObject(block)) throw new Error(`"pi-jev" must be an object`);
		return block;
	} catch (e) {
		if (!warned) console.warn(`pi-jev: ignoring settings in ${path}: ${e instanceof Error ? e.message : e}`);
		warned = true;
		return {};
	}
}

/** Env string if it parses as a number, else the settings number, else `d`. */
export function pickNum(envVal: string | undefined, setVal: unknown, d: number): number {
	if (envVal !== undefined && envVal !== "" && !Number.isNaN(Number(envVal))) return Number(envVal);
	return typeof setVal === "number" && Number.isFinite(setVal) ? setVal : d;
}

/** Hosted Jev through whichever key is set: Vercel AI Gateway first, TypeSafe when only its key exists. */
export function defaultJudge(env: NodeJS.ProcessEnv): string {
	if (secret("VERCEL_API_KEY", env) || secret("AI_GATEWAY_API_KEY", env)) return "vercel";
	return secret("TYPESAFE_API_KEY", env) ? "typesafe" : "vercel";
}

/** Selected judge: `name` as configured, `backend` for the factory, plus the named judge's url, cap, and triage overrides. */
export function resolveJudge(env: NodeJS.ProcessEnv, s: JevSettings) {
	const name = env.PI_JEV_JUDGE || s.judge || defaultJudge(env);
	const named = isObject(s.judges?.[name]) ? s.judges![name] : undefined;
	return {
		name,
		backend: named?.url ? "local" : name,
		url: env.PI_JEV_LOCAL_URL ?? named?.url ?? s.localUrl,
		stateChars: named?.stateChars ?? s.stateChars?.[name],
		drop: named?.drop,
		keep: named?.keep,
		maxBlocksPerCall: named?.maxBlocksPerCall,
	};
}

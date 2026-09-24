// Judge access for session replay: the extension's own judge, plus retry with backoff.
import { createJudge } from "../../extension/src/judge/index.ts";
import type { Judge, JudgeRequest, JevConfig } from "../../extension/src/judge/types.ts";

export function getJudge(name: JevConfig["judge"], timeoutMs: number): Judge {
	return createJudge({ judge: name, shadow: true, features: new Set(), timeoutMs });
}

const RETRY_STATUS = new Set([429, 502, 503]);
export const retryCounts: Record<string, number> = {};

/** Hosted Jev sheds load with 429/503. Retry 429/502/503 and timeouts with exponential backoff and jitter. */
export async function askWithBackoff(judge: Judge, req: JudgeRequest, attempts: number, baseMs: number, capMs: number) {
	for (let k = 0; ; k++) {
		try {
			return await judge.ask(req);
		} catch (e: any) {
			const key = e?.kind === "timeout" ? "timeout" : String(e?.status);
			if (k + 1 >= attempts || !(RETRY_STATUS.has(e?.status) || e?.kind === "timeout")) throw e;
			retryCounts[key] = (retryCounts[key] ?? 0) + 1;
			await Bun.sleep(Math.min(capMs, baseMs * 2 ** k) * (0.5 + Math.random()));
		}
	}
}

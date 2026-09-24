// Pi wiring for tool-result triage. All logic lives in core.ts (pi-free, unit-testable);
// this file only binds it to the `tool_result` event and the recall tool.
import { Type } from "typebox";
import type { JevConfig, Judge } from "../judge/types.ts";
import { addRecallNote, loadTriageConfig, makeHandler, readCache } from "./core.ts";

export function register(pi: any, judge: Judge, cfg: JevConfig): void {
	const tcfg = loadTriageConfig();
	pi.on("tool_result", makeHandler(judge, cfg, tcfg));

	// Shadow mode never hides anything, so the restore tool would just be dead schema tokens.
	if (cfg.shadow) return;

	pi.on("before_agent_start", (event: any) => void addRecallNote(event));

	pi.registerTool({
		name: "pi_jev_recall",
		label: "recall",
		description:
			"Restore text hidden by pi-jev. Call with the key and line range printed in a [pi-jev: hid lines …] stub.",
		parameters: Type.Object({
			key: Type.String({ description: "Cache key from the stub" }),
			start: Type.Number({ description: "First line to restore (inclusive)" }),
			end: Type.Number({ description: "Last line to restore (inclusive)" }),
		}),
		async execute(_toolCallId: string, params: { key: string; start: number; end: number }) {
			try {
				return {
					content: [{ type: "text", text: readCache(tcfg.cacheDir, params.key, params.start, params.end) }],
					details: undefined,
				};
			} catch (e) {
				throw new Error(`pi_jev_recall failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		},
	});
}

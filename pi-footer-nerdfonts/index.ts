import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const GLYPHS: Record<string, string> = {
  "🧠": "󰧑",
  "🔌": "󰒍",
  "○": "󰝦",
  "●": "󰝥",
  "🐴": "󱖿",
  "🌿": "󰌪",
  "⚡": "󱐋",
  "🔥": "󰈸",
};

export function nerdifyFooterStatus(text: string): string {
  return Object.entries(GLYPHS).reduce(
    (result, [emoji, glyph]) => result.replaceAll(emoji, glyph),
    text,
  );
}

export default function piFooterNerdfonts(pi: ExtensionAPI) {
  let ui: ExtensionUIContext | undefined;
  let originalSetStatus: ExtensionUIContext["setStatus"] | undefined;
  let wrappedSetStatus: ExtensionUIContext["setStatus"] | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || wrappedSetStatus) return;

    ui = ctx.ui;
    originalSetStatus = ui.setStatus;
    wrappedSetStatus = (key, text) =>
      originalSetStatus!.call(ui, key, text === undefined ? undefined : nerdifyFooterStatus(text));
    ui.setStatus = wrappedSetStatus;

    // Translate statuses emitted by extensions that loaded before this one.
    // ponytail: this briefly restores the built-in footer; remove when Pi exposes a status-transform hook.
    ui.setFooter((_tui, _theme, footerData) => {
      for (const [key, text] of footerData.getExtensionStatuses()) {
        wrappedSetStatus!(key, text);
      }
      return { render: () => [], invalidate() {} };
    });
    ui.setFooter(undefined);
  });

  pi.on("session_shutdown", () => {
    if (ui && originalSetStatus && ui.setStatus === wrappedSetStatus) {
      ui.setStatus = originalSetStatus;
    }
    ui = undefined;
    originalSetStatus = undefined;
    wrappedSetStatus = undefined;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(
    nerdifyFooterStatus("🧠 agentmemory 🔌 MCP ○ 🐴 ponytail: ⚡ FULL"),
    "󰧑 agentmemory 󰒍 MCP 󰝦 󱖿 ponytail: 󱐋 FULL",
  );
  console.log("pi-footer-nerdfonts: ok");
}

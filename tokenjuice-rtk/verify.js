import assert from "node:assert/strict";
import { test } from "node:test";

const { default: registerTokenjuice } = await import(`${new URL("./index.js", import.meta.url).href}?verify=${Date.now()}`);

function createHarness() {
  const handlers = new Map();
  registerTokenjuice({
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand() {},
    appendEntry() {},
  });

  const sessionManager = {
    getHeader: () => ({ cwd: process.cwd() }),
    getCwd: () => process.cwd(),
    getEntries: () => [],
    getBranch: () => [],
  };

  return {
    toolResult: handlers.get("tool_result"),
    ctx: {
      cwd: process.cwd(),
      hasUI: false,
      sessionManager,
      ui: { notify() {} },
    },
  };
}

function event(command) {
  const output = Array.from(
    { length: 100 },
    (_, index) => `diagnostic line ${index}: ${"detail ".repeat(8)}`,
  ).join("\n");

  return {
    toolName: "bash",
    input: { command },
    content: [{ type: "text", text: output }],
    details: {},
    isError: false,
  };
}

test("RTK-prefixed command output bypasses TokenJuice", async () => {
  const { toolResult, ctx } = createHarness();
  assert.equal(await toolResult(event("  rtk git status"), ctx), undefined);
});

test("unsupported verbose command output remains compacted", async () => {
  const { toolResult, ctx } = createHarness();
  const result = await toolResult(event("custom-verbose-command"), ctx);
  assert.ok(result);
  assert.match(result.content[0].text, /tokenjuice compacted bash output/);
});

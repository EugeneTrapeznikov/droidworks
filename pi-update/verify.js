import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const tempHome = mkdtempSync(join(tmpdir(), "pi-update-verify-"));
const stateFile = join(tempHome, ".pi", "agent", "pi-update", "state.json");
const lockFile = join(tempHome, ".pi", "agent", "pi-update", "update.lock");
const commandLog = join(tempHome, "commands.log");
const patchLog = join(tempHome, "patches.log");
const pgidLog = join(tempHome, "pgid.log");
const fakePi = join(tempHome, "fake-pi");
const fakePatcher = join(tempHome, "fake-patcher");

function readState() {
  return JSON.parse(readFileSync(stateFile, "utf8"));
}

function writeState(patch) {
  const next = { ...readState(), ...patch };
  writeFileSync(stateFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function commandCount() {
  try {
    return readFileSync(commandLog, "utf8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function waitForCommandCount(expected, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (commandCount() >= expected && readState().lastStatus !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${expected} command(s); saw ${commandCount()}`);
}

try {
  writeFileSync(
    fakePi,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${commandLog}"\nps -o pgid= -p $$ > "${pgidLog}"\nprintf 'fake update ok\\n'\n`,
    "utf8",
  );
  chmodSync(fakePi, 0o755);
  writeFileSync(
    fakePatcher,
    `from pathlib import Path\npath = Path(${JSON.stringify(patchLog)})\nwith path.open("a") as stream:\n    stream.write("patched\\n")\nprint("fake patch ok")\n`,
    "utf8",
  );
  chmodSync(fakePatcher, 0o755);

  process.env.HOME = tempHome;
  process.env.PI_UPDATE_COMMAND = fakePi;
  process.env.PI_UPDATE_PATCHER = fakePatcher;
  process.env.PI_UPDATE_START_DELAY_MS = "0";
  process.env.PI_UPDATE_TIMEOUT_MS = "3000";
  delete process.env.PI_UPDATE_INTERVAL_HOURS;
  delete process.env.PI_UPDATE_DISABLED;
  delete process.env.PI_UPDATE_FORCE;

  const moduleUrl = `${new URL("./index.js", import.meta.url).href}?verify=${Date.now()}`;
  const { default: register, resolveDefaultPatcher } = await import(moduleUrl);
  const linkedIndex = join(tempHome, "linked-pi-update-index.js");
  symlinkSync(fileURLToPath(new URL("./index.js", import.meta.url)), linkedIndex);
  assert.equal(
    resolveDefaultPatcher(pathToFileURL(linkedIndex)),
    fileURLToPath(new URL("../pi/scripts/apply-installed-patches.py", import.meta.url)),
  );

  let sessionStart;
  const commands = new Map();
  register({
    on(event, handler) {
      if (event === "session_start") sessionStart = handler;
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
  });

  assert.equal(typeof sessionStart, "function");
  assert.ok(commands.has("pi-update"));

  const ctx = {
    mode: "tui",
    hasUI: false,
    ui: { setStatus() {}, notify() {} },
  };

  await sessionStart({ reason: "startup" }, ctx);
  await waitForCommandCount(1);
  assert.equal(readFileSync(commandLog, "utf8").trim(), "update --all --no-approve");
  assert.equal(readState().lastStatus, "ok");
  assert.equal(readState().lastExitCode, 0);
  assert.equal(readState().lastPatchExitCode, 0);
  assert.equal(readFileSync(patchLog, "utf8").trim(), "patched");
  assert.match(readState().lastSummary, /fake update ok[\s\S]*fake patch ok/);
  const ownPgid = execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim();
  assert.notEqual(
    readFileSync(pgidLog, "utf8").trim(),
    ownPgid,
    "the update must run in its own process group so quitting Pi cannot kill npm mid-install",
  );

  await sessionStart({ reason: "startup" }, ctx);
  await waitForCommandCount(2);

  process.env.PI_UPDATE_INTERVAL_HOURS = "1";
  await sessionStart({ reason: "startup" }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(commandCount(), 2, "an explicit interval should throttle a successful update");

  writeState({ lastAttemptAt: Date.now() - 61 * 60 * 1000, lastStatus: "ok" });
  await sessionStart({ reason: "startup" }, ctx);
  await waitForCommandCount(3);

  writeState({ lastAttemptAt: Date.now(), lastStatus: "failed" });
  await sessionStart({ reason: "startup" }, ctx);
  await waitForCommandCount(4);

  writeState({ lastAttemptAt: Date.now(), lastStatus: "running" });
  writeFileSync(lockFile, JSON.stringify({ pid: 99999999, startedAt: Date.now() }), "utf8");
  await sessionStart({ reason: "startup" }, ctx);
  await waitForCommandCount(5);
  assert.equal(readFileSync(patchLog, "utf8").trim().split("\n").length, 5);
  delete process.env.PI_UPDATE_INTERVAL_HOURS;

  writeFileSync(fakePatcher, "import sys\nprint('unsupported patch', file=sys.stderr)\nsys.exit(7)\n", "utf8");
  await commands.get("pi-update").handler("now", ctx);
  assert.equal(commandCount(), 6);
  assert.equal(readState().lastStatus, "patch-failed");
  assert.equal(readState().lastUpdateExitCode, 0);
  assert.equal(readState().lastPatchExitCode, 7);

  console.log("PI_UPDATE_VERIFY_PASS");
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

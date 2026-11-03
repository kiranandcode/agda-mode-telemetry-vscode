// End-to-end: real VS Code + banacorn.agda-mode + this extension + agda.
// Usage: npm run test:e2e   (needs agda on PATH; on Linux, a display)
import assert from "node:assert/strict";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { launch } from "../harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const work = await launch({ suite: path.join(here, "suite.cjs"), fixture: path.join(here, "fixture") });

const db = new DatabaseSync(path.join(work, ".agda-telemetry.db"), { readOnly: true });
const events = db.prepare("SELECT * FROM events ORDER BY id").all();
const commands = events.map((e) => e.command);
assert.deepEqual(commands, [
  "session-start", "agda2-load", "agda2-make-case", "agda2-load",
  "agda2-give", "agda2-next-goal", "session-end",
]);
assert.equal(new Set(events.map((e) => e.session_id)).size, 1);
assert.ok(events.every((e) => e.file === "Test.agda" && e.line !== null && e.point !== null));
const byCmd = (c) => events.find((e) => e.command === c);
assert.equal(byCmd("agda2-make-case").goal_number, 0);
assert.match(byCmd("agda2-make-case").goal_content, /^x\s*$/);
assert.match(byCmd("agda2-give").goal_content, /^y\s*$/);
for (const c of ["agda2-load", "agda2-make-case", "agda2-give"]) assert.ok(byCmd(c).extra?.startsWith("--- "), c);
const snaps = db.prepare("SELECT event_id FROM snapshots ORDER BY id").all().map((r) => r.event_id);
const ids = Object.fromEntries(events.map((e) => [e.command, e.id]));
assert.ok(snaps.includes(events[0].id) && snaps.includes(ids["session-end"]));
const responses = db.prepare("SELECT function_name FROM responses").all().map((r) => r.function_name);
for (const f of ["agda2-status-action", "agda2-goals-action", "agda2-make-case-action", "agda2-give-action"]) {
  assert.ok(responses.includes(f), f);
}
assert.ok(!responses.some((f) => f.startsWith("agda2-highlight-")));
console.log("e2e ok:", work);

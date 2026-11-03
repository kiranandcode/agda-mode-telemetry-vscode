import assert from "node:assert/strict";
import { test } from "node:test";
import { commandName, plain, responseArgs, responseName } from "../src/agda";
import { codePoints, findHoles, sessionId, timestamp, unifiedDiff } from "../src/util";

test("timestamp matches Emacs %Y-%m-%dT%H:%M:%S.%3N%z", () => {
  assert.match(timestamp(), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d{4}$/);
});

test("session id is YYYYMMDDHHMMSS_hash", () => {
  assert.match(sessionId("/a/B.agda"), /^\d{14}_[0-9a-f]{8}$/);
});

test("commands map to agda2-mode names", () => {
  assert.equal(commandName("Load"), "agda2-load");
  assert.equal(commandName("Case"), "agda2-make-case");
  assert.equal(commandName({ TAG: "GoalType", _0: "Simplified" }), "agda2-goal-type");
  assert.equal(commandName("Refresh"), null);
  assert.equal(commandName({ TAG: "InputMethod", _0: "Activate" }), null);
  assert.equal(commandName("SomethingNew"), "agda-mode-SomethingNew");
});

test("responses map to Emacs handlers; highlighting is dropped", () => {
  assert.equal(responseName({ TAG: "InteractionPoints", _0: [0, 1] }), "agda2-goals-action");
  assert.equal(responseName({ TAG: "MakeCase", _0: "ExtendedLambda", _1: [] }), "agda2-make-case-action-extendlam");
  assert.equal(responseName({ TAG: "RunningInfo", _0: 2, _1: "x" }), "agda2-verbose");
  assert.equal(responseName({ TAG: "HighlightingInfoDirect", _0: true, _1: [] }), null);
  assert.equal(responseName("ClearHighlighting"), null);
  assert.equal(responseName("CompleteHighlightingAndMakePromptReappear"), null);
  assert.equal(responseName("ClearRunningInfo"), "agda2-info-action");
});

test("ReScript values become plain JSON", () => {
  assert.deepEqual(plain({ TAG: "GiveAction", _0: 3, _1: "GiveParen" }), ["GiveAction", 3, "GiveParen"]);
  assert.deepEqual(plain({ a: { TAG: "X", _0: [1] } }), { a: ["X", [1]] });
  assert.equal(responseArgs({ TAG: "GiveAction", _0: 0, _1: { TAG: "GiveString", _0: "y" } }), '[0,["GiveString","y"]]');
});

test("holes: nesting, comments, operators", () => {
  const src = "f = {! a {! b !} !}\n-- {! no !}\n{- {! no !} -}\ng = x --> {! y !}\n";
  const holes = findHoles(src).map((h) => src.slice(h.start, h.end));
  assert.deepEqual(holes, ["{! a {! b !} !}", "{! y !}"]);
});

test("code points count astral characters once", () => {
  assert.equal(codePoints("ℕ𝔹x"), 3);
});

test("unified diff", () => {
  assert.equal(unifiedDiff("a\n", "a\n"), null);
  const d = unifiedDiff("a\nb\n", "a\nc\n")!;
  assert.match(d, /^--- /);
  assert.match(d, /\n-b\n\+c\n/);
});

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TelemetryDb } from "../src/db";
import { exportZip, listSessions, sessionTrace } from "../src/share";
import { crc32, zip } from "../src/zip";

test("crc32 matches zlib", () => {
  assert.equal(crc32(Buffer.from("The quick brown fox jumps over the lazy dog")), 0x414fa339);
});

test("zip round-trips through unzip", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zip-test-"));
  const file = path.join(dir, "t.zip");
  fs.writeFileSync(file, zip([{ name: "a/b.txt", data: Buffer.from("hello\n".repeat(100)) }, { name: "c", data: Buffer.alloc(0) }]));
  assert.match(execFileSync("unzip", ["-t", file], { encoding: "utf8" }), /No errors detected/);
  assert.equal(execFileSync("unzip", ["-p", file, "a/b.txt"], { encoding: "utf8" }), "hello\n".repeat(100));
});

function fixtureDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tel-test-"));
  const db = TelemetryDb.open(dir);
  const ev = (command: string, ts: string, goal: [number, string] | null = null) =>
    db.insertEvent({
      session_id: "S1", timestamp: ts, command, file: "Nat.agda", point: 1, line: 3, col: 2,
      goal_number: goal ? goal[0] : null, goal_content: goal ? goal[1] : null, buffer_modified: 0,
    });
  const a = ev("session-start", "2026-04-22T10:00:00.000+0000");
  db.insertSnapshot(a, "f = ?\n");
  const b = ev("agda2-load", "2026-04-22T10:00:05.100+0000");
  db.insertSnapshot(b, "f = {!   !}\n");
  db.setExtra(b, "--- a\n+++ b\n@@ -1 +1 @@\n-f = ?\n+f = {!   !}\n");
  db.insertResponse(b, 0, "agda2-status-action", "[]");
  db.insertResponse(b, 1, "agda2-goals-action", "[[0]]");
  ev("agda2-give", "2026-04-22T10:00:07.600+0000", [0, " zero "]);
  db.close();
  return path.join(dir, ".agda-telemetry.db");
}

test("sessions and traces read back", () => {
  const p = fixtureDb();
  const [s] = listSessions(p);
  assert.equal(s.sessionId, "S1");
  assert.equal(s.events, 3);
  const md = sessionTrace(p, "S1");
  assert.match(md, /^# Nat\.agda, session S1/);
  assert.match(md, /\*\*agda2-load\*\* at 3:2 \(\+5\.1s\)\n  - Agda: agda2-status-action, agda2-goals-action/);
  assert.match(md, /goal \?0 `\{! zero !\}`/);
  assert.match(md, /```diff\n  @@ -1 \+1 @@\n  -f = \?\n  \+f = \{!   !\}/);
  assert.ok(!md.includes("--- a"));
});

test("export zips a consistent copy of each database", () => {
  const p = fixtureDb();
  const root = path.dirname(path.dirname(p));
  const out = path.join(os.tmpdir(), `export-${process.pid}.zip`);
  fs.writeFileSync(out, exportZip([p], root));
  const listing = execFileSync("unzip", ["-l", out], { encoding: "utf8" });
  assert.ok(listing.includes(`${path.basename(path.dirname(p))}/.agda-telemetry.db`));
  const x = fs.mkdtempSync(path.join(os.tmpdir(), "unz-"));
  execFileSync("unzip", ["-q", out, "-d", x]);
  const copy = path.join(x, path.basename(path.dirname(p)), ".agda-telemetry.db");
  assert.equal(listSessions(copy)[0].events, 3);
});

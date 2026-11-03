// Getting the data out: export every database as a zip, or copy one
// session as a readable trace to paste into an issue or a chat.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DB_NAME } from "./db";
import { timestamp } from "./util";
import { zip } from "./zip";

function openReadOnly(dbPath: string): DatabaseSync {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  return new DatabaseSync(dbPath, { readOnly: true });
}

/** A consistent copy of a (possibly live, WAL-mode) database. */
export function snapshotDb(dbPath: string): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agda-tel-export-"));
  const out = path.join(dir, DB_NAME);
  try {
    const db = openReadOnly(dbPath);
    try {
      db.prepare("VACUUM INTO ?").run(out);
    } finally {
      db.close();
    }
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Zip of the given databases, each at its path relative to ROOT
 *  (or under its absolute path with the root stripped if outside). */
export function exportZip(dbPaths: string[], root: string | undefined): Buffer {
  const names = new Set<string>();
  const entries = dbPaths.map((p) => {
    let name = root ? path.relative(root, p) : "";
    if (!name || name.startsWith("..") || path.isAbsolute(name)) {
      name = p.replace(/^[A-Za-z]:/, "").replace(/^[/\\]+/, "");
    }
    name = name.split(path.sep).join("/");
    while (names.has(name)) name = `_${name}`;
    names.add(name);
    return { name, data: snapshotDb(p) };
  });
  return zip(entries);
}

export function exportFileName(now = new Date()): string {
  return `agda-telemetry-${timestamp(now).slice(0, 19).replace(/[-:]/g, "").replace("T", "-")}.zip`;
}

export interface SessionInfo {
  dbPath: string;
  sessionId: string;
  file: string;
  start: string;
  end: string;
  events: number;
}

export function listSessions(dbPath: string): SessionInfo[] {
  const db = openReadOnly(dbPath);
  try {
    return (
      db
        .prepare(
          `SELECT session_id, MIN(file) AS file, MIN(timestamp) AS start,
                  MAX(timestamp) AS end, COUNT(*) AS events
           FROM events GROUP BY session_id`,
        )
        .all() as { session_id: string; file: string; start: string; end: string; events: number }[]
    ).map((r) => ({
      dbPath,
      sessionId: r.session_id,
      file: r.file,
      start: r.start,
      end: r.end,
      events: Number(r.events),
    }));
  } finally {
    db.close();
  }
}

interface EventRow {
  id: number;
  timestamp: string;
  command: string;
  file: string;
  line: number | null;
  col: number | null;
  goal_number: number | null;
  goal_content: string | null;
  extra: string | null;
}

const seconds = (a: string, b: string) => (Date.parse(fixTz(b)) - Date.parse(fixTz(a))) / 1000;
// 2026-04-22T10:00:05.100+0000 -> ...+00:00, which Date.parse accepts
const fixTz = (t: string) => t.replace(/([+-]\d\d)(\d\d)$/, "$1:$2");

/** One session as Markdown: each command with where it ran, the goal it
 *  ran in, what it did to the buffer, and what Agda answered. */
export function sessionTrace(dbPath: string, sessionId: string): string {
  const db = openReadOnly(dbPath);
  try {
    const events = db
      .prepare(
        `SELECT id, timestamp, command, file, line, col, goal_number, goal_content, extra
         FROM events WHERE session_id = ? ORDER BY id`,
      )
      .all(sessionId) as unknown as EventRow[];
    const responses = db.prepare(
      "SELECT function_name FROM responses WHERE event_id = ? ORDER BY sequence",
    );
    const final = db.prepare(
      `SELECT s.content FROM snapshots s JOIN events e ON s.event_id = e.id
       WHERE e.session_id = ? ORDER BY s.id DESC LIMIT 1`,
    ).get(sessionId) as { content: string } | undefined;

    const out: string[] = [];
    const first = events[0];
    if (!first) return `No events for session ${sessionId}.\n`;
    const last = events[events.length - 1];
    out.push(`# ${first.file}, session ${sessionId}`, "");
    out.push(
      `${events.length} events from ${first.timestamp} to ${last.timestamp} ` +
        `(${Math.round(seconds(first.timestamp, last.timestamp))}s).`,
      "",
    );
    let prev = first.timestamp;
    for (const e of events) {
      const at = e.line === null ? "" : ` at ${e.line}:${e.col}`;
      const goal =
        e.goal_number === null ? "" : `, goal ?${e.goal_number} \`{!${e.goal_content ?? ""}!}\``;
      const dt = seconds(prev, e.timestamp);
      prev = e.timestamp;
      out.push(`- **${e.command}**${at}${goal} (+${dt.toFixed(1)}s)`);
      const rs = (responses.all(e.id) as { function_name: string }[]).map((r) => r.function_name);
      if (rs.length) out.push(`  - Agda: ${rs.join(", ")}`);
      if (e.extra) {
        const hunks = e.extra.split("\n").filter((l) => !l.startsWith("---") && !l.startsWith("+++"));
        out.push("", "  ```diff", ...hunks.map((l) => `  ${l}`.trimEnd()), "  ```", "");
      }
    }
    if (final) out.push("", "## Final buffer", "", "```agda", final.content.trimEnd(), "```");
    return out.join("\n") + "\n";
  } finally {
    db.close();
  }
}

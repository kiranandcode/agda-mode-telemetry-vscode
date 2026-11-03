// SQLite storage, schema-identical to agda2-telemetry.el so that the
// Python tools (telemetry-extract.py, telemetry-replay.py) read both.

import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const DB_NAME = ".agda-telemetry.db";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL,
     timestamp TEXT NOT NULL,
     command TEXT NOT NULL,
     file TEXT NOT NULL,
     point INTEGER,
     line INTEGER,
     col INTEGER,
     goal_number INTEGER,
     goal_content TEXT,
     buffer_modified INTEGER,
     extra TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS snapshots (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     event_id INTEGER NOT NULL,
     content TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS responses (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     event_id INTEGER NOT NULL,
     sequence INTEGER NOT NULL,
     function_name TEXT NOT NULL,
     args_text TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_events_session ON events (session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events (timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_snapshots_event ON snapshots (event_id)`,
  `CREATE INDEX IF NOT EXISTS idx_responses_event ON responses (event_id)`,
];

export interface EventRow {
  session_id: string;
  timestamp: string;
  command: string;
  file: string;
  point: number | null;
  line: number | null;
  col: number | null;
  goal_number: number | null;
  goal_content: string | null;
  buffer_modified: number;
}

export class TelemetryDb {
  private constructor(private db: DatabaseSync) {}

  static open(dir: string): TelemetryDb {
    // loaded lazily: node:sqlite needs Node 22.13+, i.e. a recent VS Code
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(path.join(dir, DB_NAME));
    db.exec("PRAGMA journal_mode=WAL");
    // Emacs may be writing to the same file
    db.exec("PRAGMA busy_timeout=2000");
    for (const stmt of SCHEMA) db.exec(stmt);
    return new TelemetryDb(db);
  }

  insertEvent(e: EventRow): number {
    const r = this.db
      .prepare(
        `INSERT INTO events
           (session_id, timestamp, command, file, point,
            line, col, goal_number, goal_content, buffer_modified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.session_id, e.timestamp, e.command, e.file, e.point,
        e.line, e.col, e.goal_number, e.goal_content, e.buffer_modified,
      );
    return Number(r.lastInsertRowid);
  }

  insertSnapshot(eventId: number, content: string): void {
    this.db
      .prepare("INSERT INTO snapshots (event_id, content) VALUES (?, ?)")
      .run(eventId, content);
  }

  setExtra(eventId: number, extra: string): void {
    this.db.prepare("UPDATE events SET extra = ? WHERE id = ?").run(extra, eventId);
  }

  insertResponse(eventId: number, sequence: number, functionName: string, argsText: string | null): void {
    this.db
      .prepare(
        `INSERT INTO responses (event_id, sequence, function_name, args_text)
         VALUES (?, ?, ?, ?)`,
      )
      .run(eventId, sequence, functionName, argsText);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }
}

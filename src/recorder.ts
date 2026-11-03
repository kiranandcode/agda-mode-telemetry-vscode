// The VS Code counterpart of agda2-telemetry.el.
//
// Emacs advises agda2-mode's commands; here agda-mode-vscode's exported log
// channel plays that role:
//
//   CommandDispatched(c)  ~ :before advice on the command   -> events row
//   RequestSent(r)        ~ :before advice on agda2-go       -> round starts
//   ResponseHandled(r)    ~ :before advice on agda2-exec-response, except
//                           that agda-mode-vscode reports a response once
//                           its handler is done, so a response whose handler
//                           runs a command (make-case reloads) comes after
//                           that command's responses
//   CommandHandled(c)     ~ :after advice on agda2-run-last-commands
//                           once no request is outstanding  -> round ends:
//                           snapshot + diff if the buffer changed, responses

import * as path from "node:path";
import * as vscode from "vscode";
import { commandName, isHighlightRequest, payloadOf, responseArgs, responseName, tagOf } from "./agda";
import { DB_NAME, TelemetryDb } from "./db";
import { codePoints, findHoles, sessionId, timestamp, unifiedDiff } from "./util";

const AGDA_FILE = /\.(agda|lagda(\.(md|tex|rst|org|typ|tree))?)$/;

export function isAgdaDocument(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === "file" && AGDA_FILE.test(doc.uri.fsPath);
}

interface Round {
  session: Session;
  eventId: number;
  /** requests sent and not yet answered by a CommandHandled */
  outstanding: number;
  responses: [string, string | null][];
}

class Session {
  readonly id: string;
  readonly file: string;
  lastEventId: number | null = null;
  lastSnapshot: string | null = null;
  /** goal ids from the last agda2-goals-action, in buffer order */
  goalIds: number[] | null = null;
  /** where the cursor was when this document last had an editor, so
   *  session-end has one after the editor is gone (Emacs keeps point) */
  lastPos = new vscode.Position(0, 0);

  constructor(
    readonly doc: vscode.TextDocument,
    readonly db: TelemetryDb,
  ) {
    this.id = sessionId(doc.uri.fsPath);
    this.file = path.basename(doc.uri.fsPath);
  }

  /** The cursor of the editor showing this document, else where it was last. */
  private cursor(): vscode.Position {
    const active = vscode.window.activeTextEditor;
    const editor =
      active?.document === this.doc
        ? active
        : vscode.window.visibleTextEditors.find((e) => e.document === this.doc);
    if (editor) this.lastPos = editor.selection.active;
    return this.doc.validatePosition(this.lastPos);
  }

  /** (goal-number . goal-content) at the cursor, as agda2-telemetry--goal-info.
   *  Goals only exist once Agda has reported them, as in Emacs. */
  private goalAt(offset: number, text: string): [number, string] | [null, null] {
    if (!this.goalIds) return [null, null];
    const holes = findHoles(text);
    const i = holes.findIndex((h) => h.start <= offset && offset < h.end);
    if (i < 0 || i >= this.goalIds.length) return [null, null];
    const h = holes[i];
    return [this.goalIds[i], text.slice(h.start + 2, h.end - 2)];
  }

  log(command: string): number | null {
    try {
      const text = this.doc.getText();
      const pos = this.cursor();
      const offset = this.doc.offsetAt(pos);
      const goal = this.goalAt(offset, text);
      this.lastEventId = this.db.insertEvent({
        session_id: this.id,
        timestamp: timestamp(),
        command,
        file: this.file,
        // Emacs points count characters from 1, columns from 0
        point: codePoints(text.slice(0, offset)) + 1,
        line: pos.line + 1,
        col: codePoints(this.doc.lineAt(pos.line).text.slice(0, pos.character)),
        goal_number: goal[0],
        goal_content: goal[1],
        buffer_modified: this.doc.isDirty ? 1 : 0,
      });
      return this.lastEventId;
    } catch (e) {
      console.error("[agda-telemetry] log failed", e);
      return null;
    }
  }

  start(): void {
    const id = this.log("session-start");
    if (id !== null) {
      const content = this.doc.getText();
      this.db.insertSnapshot(id, content);
      this.lastSnapshot = content;
    }
  }

  end(): void {
    try {
      const id = this.log("session-end");
      if (id !== null) this.db.insertSnapshot(id, this.doc.getText());
    } catch (e) {
      console.error("[agda-telemetry] session-end failed", e);
    }
  }
}

export class Recorder implements vscode.Disposable {
  private sessions = new Map<string, Session>();
  private dbs = new Map<string, TelemetryDb>();
  private round: Round | null = null;
  /** the Agda document commands apply to when no editor has focus
   *  (e.g. a click in agda-mode's panel) */
  private lastAgdaDoc: vscode.TextDocument | null = null;
  private finishTimer: NodeJS.Timeout | null = null;

  /** events recorded since activation, for the status bar */
  recorded = 0;
  onDidRecord: () => void = () => {};

  constructor(private readonly enabled: () => boolean) {}

  /** the databases this window has written to */
  dbPaths(): string[] {
    return [...this.dbs.keys()].map((dir) => path.join(dir, DB_NAME));
  }

  /** the database of the Agda file in front, if any */
  activeDbPath(): string | undefined {
    const doc = vscode.window.activeTextEditor?.document ?? this.lastAgdaDoc ?? undefined;
    return doc && isAgdaDocument(doc) ? path.join(path.dirname(doc.uri.fsPath), DB_NAME) : undefined;
  }

  activeSessionId(): string | undefined {
    const doc = vscode.window.activeTextEditor?.document ?? this.lastAgdaDoc ?? undefined;
    return doc ? this.sessions.get(doc.uri.toString())?.id : undefined;
  }

  // --- sessions ---

  private dbFor(dir: string): TelemetryDb {
    let db = this.dbs.get(dir);
    if (!db) {
      db = TelemetryDb.open(dir);
      this.dbs.set(dir, db);
    }
    return db;
  }

  open(doc: vscode.TextDocument): void {
    if (!isAgdaDocument(doc) || !this.enabled()) return;
    const key = doc.uri.toString();
    if (this.sessions.has(key)) return;
    try {
      const s = new Session(doc, this.dbFor(path.dirname(doc.uri.fsPath)));
      this.sessions.set(key, s);
      s.start();
    } catch (e) {
      console.error("[agda-telemetry] could not start session for", doc.uri.fsPath, e);
    }
  }

  close(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    const s = this.sessions.get(key);
    if (!s) return;
    if (this.round?.session === s) this.finishRound();
    s.end();
    this.sessions.delete(key);
    if (this.lastAgdaDoc === doc) this.lastAgdaDoc = null;
  }

  focus(editor: vscode.TextEditor | undefined): void {
    if (editor && isAgdaDocument(editor.document)) this.lastAgdaDoc = editor.document;
  }

  moved(editor: vscode.TextEditor): void {
    const s = this.sessions.get(editor.document.uri.toString());
    if (s) s.lastPos = editor.selection.active;
  }

  private currentSession(): Session | undefined {
    const active = vscode.window.activeTextEditor?.document;
    const doc = active && isAgdaDocument(active) ? active : this.lastAgdaDoc;
    if (!doc) return undefined;
    this.open(doc);
    return this.sessions.get(doc.uri.toString());
  }

  // --- agda-mode's log channel ---

  onLog = (msg: unknown): void => {
    if (!this.enabled()) return;
    try {
      switch (tagOf(msg)) {
        case "CommandDispatched":
          return this.onCommand(payloadOf(msg)[0]);
        case "RequestSent":
          return this.onRequest(payloadOf(msg)[0]);
        case "ResponseHandled":
          return this.onResponse(payloadOf(msg)[0]);
        case "CommandHandled":
          return this.onCommandHandled();
      }
    } catch (e) {
      console.error("[agda-telemetry]", e);
    }
  };

  private onCommand(command: unknown): void {
    const name = commandName(command);
    if (!name) return;
    if (this.currentSession()?.log(name) != null) {
      this.recorded++;
      this.onDidRecord();
    }
  }

  private onRequest(request: unknown): void {
    if (this.finishTimer) {
      clearTimeout(this.finishTimer);
      this.finishTimer = null;
    }
    if (!this.round) {
      const s = this.currentSession();
      if (!s || s.lastEventId === null) return;
      this.round = { session: s, eventId: s.lastEventId, outstanding: 0, responses: [] };
    }
    // Give and Refine follow up with a Highlight request under the same
    // CommandHandled, so it doesn't count
    if (!isHighlightRequest(request)) this.round.outstanding++;
  }

  private onResponse(response: unknown): void {
    if (!this.round) return;
    if (tagOf(response) === "InteractionPoints") {
      const ids = payloadOf(response)[0];
      if (Array.isArray(ids)) this.round.session.goalIds = ids.map(Number);
    }
    const name = responseName(response);
    if (name) this.round.responses.push([name, responseArgs(response)]);
  }

  private onCommandHandled(): void {
    if (!this.round) return;
    this.round.outstanding--;
    if (this.round.outstanding > 0) return;
    // let the editor apply the last response's edits before the snapshot
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.finishTimer = setTimeout(() => {
      this.finishTimer = null;
      if (this.round && this.round.outstanding <= 0) this.finishRound();
    }, 50);
  }

  /** agda2-telemetry--after-run-last-commands */
  private finishRound(): void {
    const round = this.round;
    this.round = null;
    if (!round) return;
    const { session: s, eventId } = round;
    try {
      const post = s.doc.getText();
      if (s.lastSnapshot === null || s.lastSnapshot !== post) {
        s.db.insertSnapshot(eventId, post);
        if (s.lastSnapshot !== null) {
          const diff = unifiedDiff(s.lastSnapshot, post);
          if (diff) s.db.setExtra(eventId, diff);
        }
        s.lastSnapshot = post;
      }
      round.responses.forEach(([name, args], seq) => s.db.insertResponse(eventId, seq, name, args));
    } catch (e) {
      console.error("[agda-telemetry] finishing round failed", e);
    }
  }

  dispose(): void {
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.finishRound();
    for (const s of this.sessions.values()) s.end();
    this.sessions.clear();
    for (const db of this.dbs.values()) db.close();
    this.dbs.clear();
  }
}

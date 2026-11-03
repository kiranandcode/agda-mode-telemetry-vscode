import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { DB_NAME } from "./db";
import { isAgdaDocument, Recorder } from "./recorder";
import { exportFileName, exportZip, listSessions, sessionTrace, type SessionInfo } from "./share";

const AGDA_MODE = "banacorn.agda-mode";

interface Chan {
  on(event: "data", listener: (msg: unknown) => void): unknown;
  off(event: "data", listener: (msg: unknown) => void): unknown;
}

const config = () => vscode.workspace.getConfiguration("agdaTelemetry");
const enabled = () => config().get("enabled", true);

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  try {
    require("node:sqlite");
  } catch {
    vscode.window.showWarningMessage(
      "Agda Mode Telemetry needs a VS Code whose Node has node:sqlite (1.101 or later); telemetry is off.",
    );
    return;
  }

  const agdaMode = vscode.extensions.getExtension(AGDA_MODE);
  const exports = agdaMode && (agdaMode.isActive ? agdaMode.exports : await agdaMode.activate());
  const log: Chan | undefined = exports?.channels?.log;
  if (!log || typeof log.on !== "function") {
    vscode.window.showWarningMessage(
      "Agda Mode Telemetry: agda-mode does not expose its log channel; telemetry is off.",
    );
    return;
  }

  const recorder = new Recorder(enabled);
  log.on("data", recorder.onLog);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "agdaTelemetry.menu";
  const refresh = () => {
    const on = enabled();
    status.text = on ? "$(record) Agda telemetry" : "$(debug-pause) Agda telemetry paused";
    status.tooltip = on
      ? `Recording to ${DB_NAME} next to each Agda file (${recorder.recorded} commands in this window). Click to share or pause.`
      : "Recording is paused. Click to resume, or to share what was recorded.";
    const doc = vscode.window.activeTextEditor?.document;
    if (doc && isAgdaDocument(doc)) status.show();
    else status.hide();
  };
  recorder.onDidRecord = refresh;
  refresh();

  context.subscriptions.push(
    recorder,
    status,
    { dispose: () => log.off("data", recorder.onLog) },
    vscode.workspace.onDidOpenTextDocument((d) => recorder.open(d)),
    vscode.workspace.onDidCloseTextDocument((d) => recorder.close(d)),
    vscode.window.onDidChangeActiveTextEditor((e) => {
      recorder.focus(e);
      refresh();
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => recorder.moved(e.textEditor)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("agdaTelemetry")) return;
      if (enabled()) for (const d of vscode.workspace.textDocuments) recorder.open(d);
      refresh();
    }),
    vscode.commands.registerCommand("agdaTelemetry.menu", () => menu()),
    vscode.commands.registerCommand("agdaTelemetry.export", () => exportAll(recorder)),
    vscode.commands.registerCommand("agdaTelemetry.copySessionTrace", () => trace(recorder, "copy")),
    vscode.commands.registerCommand("agdaTelemetry.openSessionTrace", () => trace(recorder, "open")),
    vscode.commands.registerCommand("agdaTelemetry.revealDatabase", () => reveal(recorder)),
    vscode.commands.registerCommand("agdaTelemetry.pause", () => setEnabled(false)),
    vscode.commands.registerCommand("agdaTelemetry.resume", () => setEnabled(true)),
  );
  for (const d of vscode.workspace.textDocuments) recorder.open(d);
  recorder.focus(vscode.window.activeTextEditor);
}

export function deactivate(): void {
  // the Recorder is disposed with the context's subscriptions, ending sessions
}

const setEnabled = (on: boolean) =>
  config().update("enabled", on, vscode.ConfigurationTarget.Global);

async function menu(): Promise<void> {
  const items: (vscode.QuickPickItem & { command: string })[] = [
    { label: "$(package) Export telemetry…", description: "zip every database in the workspace", command: "agdaTelemetry.export" },
    { label: "$(copy) Copy session trace", description: "one session as Markdown", command: "agdaTelemetry.copySessionTrace" },
    { label: "$(book) Open session trace", description: "the same, in an editor", command: "agdaTelemetry.openSessionTrace" },
    { label: "$(folder-opened) Reveal database", description: DB_NAME, command: "agdaTelemetry.revealDatabase" },
    enabled()
      ? { label: "$(debug-pause) Pause recording", command: "agdaTelemetry.pause" }
      : { label: "$(record) Resume recording", command: "agdaTelemetry.resume" },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: "Agda telemetry" });
  if (pick) await vscode.commands.executeCommand(pick.command);
}

/** Every database in the workspace, plus any this window wrote outside it. */
async function allDbPaths(recorder: Recorder): Promise<string[]> {
  const found = await vscode.workspace.findFiles(`**/${DB_NAME}`, "**/node_modules/**");
  const paths = new Set([...found.map((u) => u.fsPath), ...recorder.dbPaths()]);
  return [...paths].filter((p) => fs.existsSync(p)).sort();
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

async function exportAll(recorder: Recorder): Promise<void> {
  const dbs = await allDbPaths(recorder);
  if (!dbs.length) {
    vscode.window.showInformationMessage("No Agda telemetry recorded in this workspace yet.");
    return;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  const root = folders.length === 1 ? folders[0].uri.fsPath : undefined;
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(root ?? path.dirname(dbs[0]), exportFileName())),
    filters: { "Zip archive": ["zip"] },
    title: `Export ${plural(dbs.length, "telemetry database")}`,
  });
  if (!target) return;
  try {
    fs.writeFileSync(target.fsPath, exportZip(dbs, root));
  } catch (e) {
    vscode.window.showErrorMessage(`Export failed: ${e instanceof Error ? e.message : e}`);
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `Exported ${plural(dbs.length, "database")} to ${path.basename(target.fsPath)}.`,
    "Reveal",
    "Copy path",
  );
  if (choice === "Reveal") await vscode.commands.executeCommand("revealFileInOS", target);
  if (choice === "Copy path") await vscode.env.clipboard.writeText(target.fsPath);
}

async function pickSession(recorder: Recorder): Promise<SessionInfo | undefined> {
  const sessions: SessionInfo[] = [];
  for (const db of await allDbPaths(recorder)) {
    try {
      sessions.push(...listSessions(db));
    } catch {
      // unreadable database: skip it
    }
  }
  if (!sessions.length) {
    vscode.window.showInformationMessage("No Agda telemetry recorded in this workspace yet.");
    return;
  }
  sessions.sort((a, b) => b.start.localeCompare(a.start));
  const current = recorder.activeSessionId();
  const items = sessions.map((s) => ({
    label: `${s.sessionId === current ? "$(record) " : ""}${s.file}`,
    description: `${s.start.slice(0, 16).replace("T", " ")} · ${plural(s.events, "event")}`,
    detail: vscode.workspace.asRelativePath(s.dbPath),
    session: s,
  }));
  const pick = await vscode.window.showQuickPick(items, {
    title: "Agda telemetry sessions",
    matchOnDetail: true,
  });
  return pick?.session;
}

async function trace(recorder: Recorder, how: "copy" | "open"): Promise<void> {
  const s = await pickSession(recorder);
  if (!s) return;
  const text = sessionTrace(s.dbPath, s.sessionId);
  if (how === "copy") {
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(`Copied the trace of ${s.file} (${plural(s.events, "event")}).`);
  } else {
    const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: text });
    await vscode.window.showTextDocument(doc);
  }
}

async function reveal(recorder: Recorder): Promise<void> {
  const active = recorder.activeDbPath();
  const target = active && fs.existsSync(active) ? active : (await allDbPaths(recorder))[0];
  if (!target) {
    vscode.window.showInformationMessage("No Agda telemetry recorded in this workspace yet.");
    return;
  }
  await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(target));
}

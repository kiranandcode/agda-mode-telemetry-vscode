// The README's demos, run inside VS Code. With $DISPLAY and $DEMO_OUT set
// (Linux + Xvfb, see run.mjs) keys are real keystrokes via xdotool, so
// screencast mode shows them, and each scene is recorded with ffmpeg.
// Without them it still runs, with commands instead of keys.
const vscode = require("vscode");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

const OUT = process.env.DEMO_OUT;
const X = Boolean(OUT && process.env.DISPLAY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function xdo(...args) {
  execFileSync("xdotool", args);
}

// agda-mode's default keybindings, and what they do without a keyboard
const KEYS = {
  load: ["ctrl+c ctrl+l", "agda-mode.load"],
  case: ["ctrl+c ctrl+c", "agda-mode.case"],
  give: ["ctrl+c ctrl+space", "agda-mode.give"],
  nextGoal: ["ctrl+c ctrl+f", "agda-mode.next-goal"],
};

let recorder = null;
function startRecording(name) {
  if (!X) return;
  recorder = spawn("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "x11grab", "-draw_mouse", "0", "-framerate", "15",
    "-video_size", process.env.DEMO_SIZE || "1280x800", "-i", process.env.DISPLAY,
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-pix_fmt", "yuv444p",
    path.join(OUT, `${name}.mp4`),
  ], { stdio: ["pipe", "inherit", "inherit"] });
}
async function stopRecording() {
  if (!recorder) return;
  const r = recorder;
  recorder = null;
  const done = new Promise((res) => r.on("exit", res));
  r.stdin.write("q");
  await done;
}

exports.run = async function () {
  const work = process.env.AGDA_TEL_WORK;
  const agdaMode = vscode.extensions.getExtension("banacorn.agda-mode");
  const { channels } = agdaMode.isActive ? agdaMode.exports : await agdaMode.activate();
  const handled = () =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, 30000);
      const f = (msg) => {
        if (msg && msg.TAG === "CommandHandled") {
          clearTimeout(t);
          channels.log.off("data", f);
          resolve();
        }
      };
      channels.log.on("data", f);
    });

  const press = async (key, waitForAgda = true) => {
    const [chord, command] = KEYS[key];
    const done = waitForAgda ? handled() : null;
    if (X) xdo("key", "--delay", "250", ...chord.split(" "));
    else await vscode.commands.executeCommand(command);
    if (done) await done;
    await sleep(900);
  };
  const type = async (text) => {
    if (X) xdo("type", "--delay", "110", text);
    else {
      const ed = vscode.window.activeTextEditor;
      await ed.edit((e) => e.insert(ed.selection.active, text));
    }
    await sleep(500);
  };

  const doc = await vscode.workspace.openTextDocument(path.join(work, "Nat.agda"));
  const editor = await vscode.window.showTextDocument(doc);
  if (X) {
    const win = execFileSync("xdotool", ["search", "--onlyvisible", "--class", "code"], { encoding: "utf8" })
      .trim().split("\n").pop();
    const [w, h] = (process.env.DEMO_SIZE || "1280x800").split("x");
    xdo("windowmove", win, "0", "0");
    xdo("windowsize", win, w, h);
    xdo("windowfocus", "--sync", win);
    await vscode.commands.executeCommand("workbench.action.toggleScreencastMode");
  }
  await vscode.commands.executeCommand("workbench.action.closeSidebar");
  await vscode.commands.executeCommand("workbench.action.closePanel");
  // put the cursor on the hole
  const hole = doc.getText().indexOf("?");
  editor.selection = new vscode.Selection(doc.positionAt(hole), doc.positionAt(hole));
  await sleep(1500);

  // 1. prove x + y as usual; every step lands in .agda-telemetry.db
  startRecording("record");
  await sleep(800);
  await press("load");
  await press("nextGoal", false);
  await type("x");
  await press("case");
  await type("y");
  await press("give");
  await press("nextGoal", false);
  await type("suc (x + y)");
  await press("give");
  await sleep(1500);
  await stopRecording();

  // 2. the status bar menu: copy or open a session as Markdown
  await doc.save();
  startRecording("share");
  await sleep(800);
  // not awaited: it resolves once the quick picks close
  const menu = vscode.commands.executeCommand("agdaTelemetry.menu");
  await sleep(1500);
  await vscode.commands.executeCommand("workbench.action.quickOpenSelectNext");
  await sleep(400);
  await vscode.commands.executeCommand("workbench.action.quickOpenSelectNext");
  await sleep(900);
  await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
  await sleep(1500);
  await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
  await menu;
  await sleep(1200);
  await vscode.commands.executeCommand("markdown.showPreviewToSide");
  await sleep(3500);
  await stopRecording();

  // 3. the same database, replayed by the Emacs repo's Python tools
  if (process.env.DEMO_REPLAY) {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const term = vscode.window.createTerminal({ name: "replay", cwd: work });
    term.show();
    await vscode.commands.executeCommand("workbench.action.toggleMaximizedPanel");
    await sleep(2500);
    startRecording("replay");
    await sleep(500);
    term.sendText(`python3 ${process.env.DEMO_REPLAY} . replay 2>&1 | less -R`);
    await sleep(3000);
    for (let i = 0; i < 8; i++) {
      if (X) xdo("key", "space");
      await sleep(1200);
    }
    await stopRecording();
    if (X) xdo("key", "q");
  }

  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await sleep(500);
};

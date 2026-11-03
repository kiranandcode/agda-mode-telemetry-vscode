// Runs inside the VS Code extension host.
const vscode = require("vscode");
const path = require("node:path");

exports.run = async function () {
  const work = process.env.AGDA_TEL_WORK;
  const agdaMode = vscode.extensions.getExtension("banacorn.agda-mode");
  const { channels } = agdaMode.isActive ? agdaMode.exports : await agdaMode.activate();
  const handled = () =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timed out waiting for CommandHandled")), 60000);
      const f = (msg) => {
        if (msg && msg.TAG === "CommandHandled") {
          clearTimeout(t);
          channels.log.off("data", f);
          setTimeout(resolve, 300);
        }
      };
      channels.log.on("data", f);
    });
  const run = async (cmd) => {
    const done = handled();
    await vscode.commands.executeCommand(cmd);
    await done;
  };
  const goTo = (editor, needle, delta = 0) => {
    const off = editor.document.getText().indexOf(needle) + delta;
    const p = editor.document.positionAt(off);
    editor.selection = new vscode.Selection(p, p);
  };

  const doc = await vscode.workspace.openTextDocument(path.join(work, "Test.agda"));
  const editor = await vscode.window.showTextDocument(doc);
  await new Promise((r) => setTimeout(r, 500));

  await run("agda-mode.load");
  if (!/\{!\s*!\}/.test(doc.getText())) throw new Error("load did not turn ? into goals:\n" + doc.getText());

  // case split on x in the first goal
  goTo(editor, "add x y = {!", 12);
  await editor.edit((e) => e.insert(editor.selection.active, "x"));
  goTo(editor, "add x y = {!", 12);
  await run("agda-mode.case");
  if (!doc.getText().includes("add (suc x) y")) throw new Error("case split failed:\n" + doc.getText());

  // give y in the zero case
  goTo(editor, "add zero y = {!", 15);
  await editor.edit((e) => e.insert(editor.selection.active, "y"));
  goTo(editor, "add zero y = {!", 15);
  await run("agda-mode.give");
  if (!doc.getText().includes("add zero y = y")) throw new Error("give failed:\n" + doc.getText());

  await vscode.commands.executeCommand("agda-mode.next-goal");
  await new Promise((r) => setTimeout(r, 300));

  await doc.save();
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await new Promise((r) => setTimeout(r, 1000));
};

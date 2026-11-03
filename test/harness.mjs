// Launches VS Code with banacorn.agda-mode and this extension on a fresh
// copy of a fixture, and runs SUITE inside it. Shared by the e2e test and
// the demo recorder.
//
// VS Code: $VSCODE_PATH if set, else the macOS app if present, else a
// download of stable (cached in .vscode-test/). Agda: `agda` on PATH.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from "@vscode/test-electron";

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, "..");

const MAC_APP = "/Applications/Visual Studio Code.app/Contents/MacOS/Code";

async function vscodePath() {
  if (process.env.VSCODE_PATH) return process.env.VSCODE_PATH;
  if (process.platform === "darwin" && fs.existsSync(MAC_APP)) return MAC_APP;
  return downloadAndUnzipVSCode("stable");
}

export async function launch({ suite, fixture, settings = {}, env = {} }) {
  const vscodeExecutablePath = await vscodePath();
  const extDir = path.join(root, ".vscode-test", "extensions");
  const userDir = path.join(root, ".vscode-test", `user-${path.basename(suite, ".cjs")}`);
  fs.mkdirSync(extDir, { recursive: true });
  if (!fs.readdirSync(extDir).some((d) => d.startsWith("banacorn.agda-mode"))) {
    const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
    execFileSync(cli, [...args, "--extensions-dir", extDir, "--install-extension", "banacorn.agda-mode"], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agda-tel-"));
  fs.cpSync(fixture, work, { recursive: true });
  const agda = execFileSync("which", ["agda"], { encoding: "utf8" }).trim();
  fs.rmSync(userDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(userDir, "User"), { recursive: true });
  fs.writeFileSync(
    path.join(userDir, "User", "settings.json"),
    JSON.stringify({
      "agdaMode.connection.paths": [agda],
      "workbench.startupEditor": "none",
      "workbench.tips.enabled": false,
      "chat.disableAIFeatures": true,
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
      "extensions.ignoreRecommendations": true,
      "security.workspace.trust.enabled": false,
      ...settings,
    }),
  );

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: suite,
    launchArgs: [work, "--extensions-dir", extDir, "--user-data-dir", userDir, "--disable-workspace-trust"],
    extensionTestsEnv: { AGDA_TEL_WORK: work, ...env },
  });
  return work;
}

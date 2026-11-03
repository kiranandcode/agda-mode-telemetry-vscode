// Records the README's GIFs into images/. Run on Linux under Xvfb with
// xdotool and ffmpeg (CI does this, see .github/workflows/demo.yml):
//   DISPLAY=:99 DEMO_REPLAY=path/to/telemetry-replay.py npm run demo
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, root } from "../harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, ".vscode-test", "demo");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

await launch({
  suite: path.join(here, "suite.cjs"),
  fixture: path.join(here, "fixture"),
  settings: {
    "window.zoomLevel": 1,
    "editor.fontSize": 15,
    "editor.minimap.enabled": false,
    "workbench.colorTheme": "Default Dark Modern",
    "screencastMode.fontSize": 36,
    "screencastMode.onlyKeyboardShortcuts": true,
    "screencastMode.verticalOffset": 12,
    "breadcrumbs.enabled": false,
    "window.commandCenter": false,
    "workbench.layoutControl.enabled": false,
    "terminal.integrated.fontSize": 14,
  },
  env: { DEMO_OUT: out },
});

const images = path.join(root, "images");
fs.mkdirSync(images, { recursive: true });
for (const f of fs.readdirSync(out).filter((f) => f.endsWith(".mp4"))) {
  const gif = path.join(images, f.replace(/\.mp4$/, ".gif"));
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-i", path.join(out, f),
    "-vf", "fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
    gif,
  ]);
  console.log(gif, `${Math.round(fs.statSync(gif).size / 1024)} KiB`);
}

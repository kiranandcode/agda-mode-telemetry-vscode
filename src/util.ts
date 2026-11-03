import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTwoFilesPatch } from "diff";

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Local time as Emacs' (format-time-string "%Y-%m-%dT%H:%M:%S.%3N%z"). */
export function timestamp(d = new Date()): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(a / 60))}${pad(a % 60)}`
  );
}

/** YYYYMMDDHHMMSS_hash, as agda2-telemetry-setup makes it. */
export function sessionId(file: string, d = new Date()): string {
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const hash = createHash("md5")
    .update(`${process.pid}${file}${d.getTime() / 1000}`)
    .digest("hex")
    .slice(0, 8);
  return `${stamp}_${hash}`;
}

/** Unified diff of BEFORE and AFTER, or null if identical. Uses diff(1) on
 *  temp files like agda2-telemetry--compute-diff, falling back to jsdiff
 *  where there is no diff(1). */
export function unifiedDiff(before: string, after: string): string | null {
  if (before === after) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agda-tel-"));
  const a = path.join(dir, "a");
  const b = path.join(dir, "b");
  try {
    fs.writeFileSync(a, before);
    fs.writeFileSync(b, after);
    const r = spawnSync("diff", ["-u", a, b], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    // diff exits 1 when the files differ
    if (r.status === 1 && r.stdout) return r.stdout;
  } catch {
    // fall through
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return createTwoFilesPatch(a, b, before, after).replace(/^=+\n/, "");
}

/** Number of code points in S: Emacs counts characters, JS UTF-16 units. */
export function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export interface Hole {
  /** UTF-16 offsets of the `{!` and just past the `!}` */
  start: number;
  end: number;
}

/** The `{! ... !}` holes of an Agda source, in order, skipping comments.
 *  Holes nest: `{! {! !} !}` is one hole. */
export function findHoles(text: string): Hole[] {
  const holes: Hole[] = [];
  let i = 0;
  let depth = 0;
  let start = 0;
  let commentDepth = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (depth === 0 && commentDepth === 0 && two === "--") {
      // line comment, unless part of an operator like `-->` or `|--`
      const prev = text[i - 1];
      let j = i;
      while (text[j] === "-") j++;
      const next = text[j];
      const sym = /[!#$%&*+./<=>?@\\^|~:]/;
      if (!(prev && sym.test(prev)) && !(next && sym.test(next))) {
        const nl = text.indexOf("\n", i);
        i = nl < 0 ? text.length : nl;
        continue;
      }
    }
    if (depth === 0 && two === "{-") {
      commentDepth++;
      i += 2;
      continue;
    }
    if (depth === 0 && commentDepth > 0 && two === "-}") {
      commentDepth--;
      i += 2;
      continue;
    }
    if (commentDepth === 0 && two === "{!") {
      if (depth === 0) start = i;
      depth++;
      i += 2;
      continue;
    }
    if (commentDepth === 0 && depth > 0 && two === "!}") {
      depth--;
      i += 2;
      if (depth === 0) holes.push({ start, end: i });
      continue;
    }
    i++;
  }
  return holes;
}

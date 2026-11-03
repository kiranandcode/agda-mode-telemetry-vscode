// Decoding the values agda-mode-vscode (banacorn.agda-mode) puts on its
// exported log channel. It is written in ReScript 11, whose variants compile
// to a bare string when they carry no payload ("Load") and to
// { TAG: "Give", _0: ..., _1: ... } when they do.

export type Variant = string | { TAG: string; [field: string]: unknown };

export function tagOf(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as { TAG?: unknown }).TAG === "string") {
    return (v as { TAG: string }).TAG;
  }
  return undefined;
}

export function payloadOf(v: unknown): unknown[] {
  if (!v || typeof v !== "object") return [];
  const out: unknown[] = [];
  for (let i = 0; `_${i}` in (v as object); i++) out.push((v as Record<string, unknown>)[`_${i}`]);
  return out;
}

// agda-mode-vscode commands, named after the agda2-mode command that does the
// same thing so that sessions from both editors read alike. null = not logged:
// these are editor plumbing that agda2-telemetry.el doesn't see either
// (Refresh fires on every tab switch, InputMethod on every keystroke of the
// input method, EventFromView on clicks in the panel).
const COMMANDS: Record<string, string | null> = {
  Load: "agda2-load",
  Quit: "agda2-quit",
  Restart: "agda2-restart",
  Refresh: null,
  Compile: "agda2-compile",
  ToggleDisplayOfImplicitArguments: "agda2-display-implicit-arguments",
  ToggleDisplayOfIrrelevantArguments: "agda2-display-irrelevant-arguments",
  ShowConstraints: "agda2-show-constraints",
  SolveConstraints: "agda2-solve-maybe-all",
  ShowGoals: "agda2-show-goals",
  NextGoal: "agda2-next-goal",
  PreviousGoal: "agda2-previous-goal",
  SearchAbout: "agda2-search-about-toplevel",
  Give: "agda2-give",
  Refine: "agda2-refine",
  ElaborateAndGive: "agda2-elaborate-give",
  Auto: "agda2-mimer-maybe-all",
  Case: "agda2-make-case",
  HelperFunctionType: "agda2-helper-function-type",
  InferType: "agda2-infer-type-maybe-toplevel",
  Context: "agda2-show-context",
  GoalType: "agda2-goal-type",
  GoalTypeAndContext: "agda2-goal-and-context",
  EventFromView: null,
  GoalTypeContextAndInferredType: "agda2-goal-and-context-and-inferred",
  GoalTypeContextAndCheckedType: "agda2-goal-and-context-and-checked",
  ModuleContents: "agda2-module-contents-maybe-toplevel",
  ComputeNormalForm: "agda2-compute-normalised-maybe-toplevel",
  WhyInScope: "agda2-why-in-scope-maybe-toplevel",
  SwitchAgdaVersion: "agda2-set-program-version",
  Escape: "agda2-abort",
  InputMethod: null,
  LookupSymbol: "describe-char",
  OpenDebugBuffer: null,
};

/** The command name to log, or null to skip. Unknown commands (a newer
 *  agda-mode) are logged under their own name. */
export function commandName(command: unknown): string | null {
  const tag = tagOf(command);
  if (tag === undefined) return null;
  return tag in COMMANDS ? COMMANDS[tag] : `agda-mode-${tag}`;
}

/** The Emacs response handler a response came from, or null for the ones
 *  agda2-telemetry.el leaves out (highlighting) and agda-mode-vscode's own
 *  synthetic CompleteHighlightingAndMakePromptReappear. */
export function responseName(response: unknown): string | null {
  const tag = tagOf(response);
  const args = payloadOf(response);
  switch (tag) {
    case "HighlightingInfoDirect":
    case "HighlightingInfoIndirect":
    case "HighlightingInfoIndirectJSON":
    case "ClearHighlighting":
    case "CompleteHighlightingAndMakePromptReappear":
      return null;
    case "Status":
      return "agda2-status-action";
    case "JumpToError":
      return "agda2-maybe-goto";
    case "InteractionPoints":
      return "agda2-goals-action";
    case "GiveAction":
      return "agda2-give-action";
    case "MakeCase":
      return tagOf(args[0]) === "ExtendedLambda"
        ? "agda2-make-case-action-extendlam"
        : "agda2-make-case-action";
    case "SolveAll":
      return "agda2-solveAll-action";
    case "DisplayInfo":
    case "ClearRunningInfo":
      return "agda2-info-action";
    case "RunningInfo":
      return args[0] === 2 ? "agda2-verbose" : "agda2-info-action";
    case "DoneAborting":
      return "agda2-abort-done";
    case "DoneExiting":
      return "agda2-exit-done";
    case undefined:
      return null;
    default:
      return `agda-mode-${tag}`;
  }
}

/** ReScript runtime value -> plain JSON: variants become their tag, or
 *  [tag, ...payload] when they carry one. */
export function plain(v: unknown, depth = 0): unknown {
  if (depth > 64) return "<deep>";
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map((x) => plain(x, depth + 1));
  if (typeof v === "object") {
    const tag = tagOf(v);
    if (tag !== undefined) {
      const args = payloadOf(v);
      return args.length ? [tag, ...args.map((x) => plain(x, depth + 1))] : [tag];
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (typeof x !== "function") out[k] = plain(x, depth + 1);
    }
    return out;
  }
  if (typeof v === "bigint") return Number(v);
  return v;
}

/** args_text for a response: its arguments as JSON. (agda2-telemetry.el
 *  stores the Emacs s-expression; VS Code only ever sees parsed responses.) */
export function responseArgs(response: unknown): string | null {
  try {
    return JSON.stringify(payloadOf(response).map((x) => plain(x)));
  } catch {
    return "<unserializable>";
  }
}

export function isHighlightRequest(request: unknown): boolean {
  return tagOf(request) === "Highlight";
}

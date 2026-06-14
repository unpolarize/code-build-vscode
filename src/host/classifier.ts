// Turn classifier. After each `result` end-of-turn event, runs a
// short one-shot fork of the active backend ("using current coder
// model/agent" per notes.md) to label the turn with ≤3 short topic
// tags. Labels render as chips above the user bubble in the webview.
//
// Cost: a Haiku-tier call per turn. Off by default
// (`codeBuild.classifyTurns`). Errors are swallowed — classification
// is decorative; a failure should never break the turn UX.

import { spawn } from "node:child_process";
import * as path from "node:path";

const PROMPT = `Classify the following USER+ASSISTANT exchange into 1 to 3 short, lowercase topic tags (each 1-3 words; prefer reusing existing project-specific tags if the conversation context hints at any). Return ONLY a JSON object of the form {"labels":["a","b","c"]} — no prose, no markdown, no code fence.`;

export interface ClassifyOpts {
  /** "claude" or "grok" — the backend we're forking for the classify
   * call. Today only claude is supported (one-shot \`claude -p
   * --output-format json\`). Grok one-shot mode pending. */
  backend: "claude" | "grok" | string;
  /** Resolved binary path (matches the live transport's binOverrides
   * resolution). */
  bin: string;
  /** Optional model override; defaults to the lowest-cost tier the
   * backend offers (haiku for claude). */
  model?: string;
  /** Hard upper bound; defaults to 20 s. */
  timeoutMs?: number;
}

/** Strip JSON out of a possibly-fenced answer. Claude with
 * --output-format json wraps the entire reply in a {result:"..."}
 * envelope, where the inner result is the model's actual text. The
 * text MIGHT be json or fenced-json. Belt-and-suspenders parsing
 * tolerates all four common shapes. */
function extractLabels(raw: string): string[] {
  let text = raw;
  // Step 1: peel claude's JSON envelope if present.
  try {
    const env = JSON.parse(raw) as { result?: string; text?: string };
    if (typeof env.result === "string") text = env.result;
    else if (typeof env.text === "string") text = env.text;
  } catch {
    /* not JSON envelope; treat as direct text */
  }
  // Step 2: strip a ```json fence if there is one.
  text = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  // Step 3: find the first { ... } block and parse it.
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const obj = JSON.parse(m[0]) as { labels?: unknown };
    if (!Array.isArray(obj.labels)) return [];
    return obj.labels
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((s) => s.trim().toLowerCase())
      .slice(0, 3);
  } catch {
    return [];
  }
}

/** Run the classifier. Returns the labels or `[]` on any failure. */
export async function classifyTurn(
  userText: string,
  assistantText: string,
  opts: ClassifyOpts
): Promise<string[]> {
  if (opts.backend !== "claude") {
    // Grok one-shot isn't wired yet; ACP doesn't have a documented
    // headless-prompt mode. Falls through to no-op for now.
    return [];
  }
  const args = ["-p", "--output-format", "json"];
  if (opts.model && opts.model !== "default") args.push("--model", opts.model);
  const prompt = `${PROMPT}\n\n=== USER ===\n${userText.slice(0, 4000)}\n\n=== ASSISTANT ===\n${assistantText.slice(0, 8000)}`;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  return new Promise<string[]>((resolve) => {
    let done = false;
    const finish = (labels: string[]) => {
      if (done) return;
      done = true;
      resolve(labels);
    };
    let stdout = "";
    try {
      const proc = spawn(opts.bin, args, { stdio: ["pipe", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        proc.kill();
        finish([]);
      }, timeoutMs);
      proc.stdout.on("data", (b: Buffer) => {
        stdout += b.toString();
      });
      proc.on("error", () => {
        clearTimeout(timer);
        finish([]);
      });
      proc.on("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0) return finish([]);
        finish(extractLabels(stdout));
      });
      proc.stdin.write(prompt);
      proc.stdin.end();
    } catch {
      finish([]);
    }
  });
}

// path is imported for parity with the rest of the host code; unused
// here but typed so removing it doesn't shift line numbers in tooling.
void path;

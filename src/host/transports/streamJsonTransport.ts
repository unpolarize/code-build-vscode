import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';
import type {
  BackendId,
  ContentBlock,
  PermissionMode,
  PermissionOutcome
} from '../../shared/acpTypes';
import { BaseAgentSession, type StartOpts } from '../agentSession';
import { BACKENDS, resolveBin } from '../backendRegistry';
import { ClaudeNormalizer } from './normalizers/claude';

/**
 * Drives stream-json / NDJSON backends. P1 supports the persistent-stdin model
 * (Claude): one long-lived process; each prompt is written as a stream-json line.
 * Codex (spawn-per-prompt) is added in P4 via a second prompt mode.
 */
export class StreamJsonTransport extends BaseAgentSession {
  private proc?: ChildProcessWithoutNullStreams;
  private normalizer = new ClaudeNormalizer();
  private mode: PermissionMode = 'default';
  private started = false;
  private startOpts?: StartOpts;
  /** True once we've spawned the agent without `--resume` after a failed
   * resume attempt. Prevents an infinite retry loop if the no-resume
   * spawn itself fails. */
  private resumeFallbackAttempted = false;
  /** Pending SIGKILL escalation armed by cancel(). Cleared when the process
   * exits (the graceful SIGINT landed) so we don't kill a respawned proc. */
  private cancelEscalation?: ReturnType<typeof setTimeout>;

  constructor(
    public readonly id: string,
    public readonly backend: BackendId,
    private readonly binOverrides: Record<string, string>
  ) {
    super();
  }

  async start(opts: StartOpts): Promise<void> {
    this.startOpts = opts;
    this.mode = opts.mode;
    this.spawnProcess();
  }

  private spawnProcess(): void {
    const spec = BACKENDS[this.backend];
    const bin = resolveBin(spec, this.binOverrides);
    const args = spec.buildArgs({
      cwd: this.startOpts!.cwd,
      mode: this.mode,
      model: this.startOpts!.model,
      resumeId: this.startOpts!.resumeId ?? this.normalizer.sessionId,
      effort: this.startOpts!.effort,
      allowBypass: this.startOpts!.allowBypass,
      additionalTrustedDirs: this.startOpts!.additionalTrustedDirs
    });

    // Curated env: keep subscription auth working, never inject API keys here.
    const env = { ...process.env };

    this.proc = spawn(bin, args, {
      cwd: this.startOpts!.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.started = true;

    // Buffer the LAST stdout line too — claude code 2.1.x sometimes
    // surfaces a startup failure as a stream-json `result` event with
    // `is_error: true` and an `error` field, then exits with code 1 and
    // an EMPTY stderr (which is what produced the silent code-1 the user
    // reported). We capture both and include them in the exit-time error
    // bubble so the user has SOMETHING to act on.
    let lastStdoutLine = '';
    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => {
      if (line.trim()) lastStdoutLine = line.slice(0, 4096);
      this.onStdoutLine(line);
    });

    // Buffer stderr so the exit handler can surface the actual error in the
    // chat rather than the opaque "exited with code 1" the user used to see.
    // Cap at 8 KB to avoid memory growth on a runaway log; claude's real
    // errors are usually a single line.
    let stderrBuf = '';
    this.proc.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString();
      if (text.trim()) {
        console.error(`[code-build:${this.backend}] ${text.trim()}`);
        if (stderrBuf.length < 8192) {
          stderrBuf += text;
        }
      }
    });

    this.proc.on('error', (err) => {
      this.emit({ kind: 'error', message: `Failed to start ${bin}: ${err.message}` });
    });

    const resumeIdHint = this.startOpts?.resumeId;
    this.proc.on('exit', (code) => {
      this.started = false;
      // The process is gone — the graceful SIGINT (or a real exit) landed,
      // so cancel the pending force-kill escalation.
      if (this.cancelEscalation) {
        clearTimeout(this.cancelEscalation);
        this.cancelEscalation = undefined;
      }
      if (code && code !== 0) {
        const stderr = stderrBuf.trim();
        // Try to extract a structured error from claude's last stream-json
        // line — `result` events with is_error / subtype:'error_during_*'
        // carry the actual reason ("Session conflict", "rate limit", etc.)
        // that doesn't always land in stderr.
        let stdoutErr = '';
        if (lastStdoutLine) {
          try {
            const obj = JSON.parse(lastStdoutLine) as {
              type?: string;
              subtype?: string;
              is_error?: boolean;
              error?: string;
              result?: string;
            };
            if (obj?.is_error || /error/.test(obj?.subtype ?? '')) {
              stdoutErr = obj.error || obj.result || obj.subtype || lastStdoutLine;
            }
          } catch {
            /* not JSON or malformed — fall through to including the raw line */
          }
        }

        // Auto-fallback for resume failures. If we spawned with --resume
        // and claude exited 1 (the active-session guard didn't catch this
        // — could be a race between chrome panel restart and control-file
        // write, OR a genuine "session not found"), re-spawn ONCE without
        // --resume. The transcript replay already in the webview keeps
        // the user's context; they can keep chatting in a fresh agent
        // process. Without this, claude resume failures landed as red
        // errors with no recovery — the user had to manually start a
        // new session.
        if (resumeIdHint && !this.resumeFallbackAttempted) {
          this.resumeFallbackAttempted = true;
          this.emit({
            kind: 'error', // 'notice' isn't a SessionUpdate kind — keep error
            // tier but the wording makes the recovery clear.
            message:
              `Couldn't resume Claude session \`${resumeIdHint.slice(0, 8)}\` — starting a fresh agent in the same cwd. ` +
              `(Reason: ${stdoutErr || stderr || `exit ${code}`}.) The transcript above is preserved as read-only context.`
          });
          // Clear the resume id and re-spawn. The transport keeps using
          // the same startOpts but spawnProcess() reads resumeId from
          // there, so wipe it first.
          if (this.startOpts) this.startOpts.resumeId = undefined;
          this.spawnProcess();
          return;
        }

        let hint = '';
        if (resumeIdHint) {
          const probe = `${stderr} ${stdoutErr}`.toLowerCase();
          if (/already (in use|active|open)|resume.*active|session conflict|already running/.test(probe)) {
            hint = `\n\nThis session is already running in another claude process. Close the other panel (or kill the pid shown in \`~/.claude/sessions/*.json\`) and click "Open in Code Build" again to take it over.`;
          } else if (/not found|no such session/.test(probe)) {
            hint = `\n\nClaude couldn't locate the session by id. The upstream transcript may have been deleted or never existed.`;
          } else if (/rate.?limit|quota/.test(probe)) {
            hint = `\n\nClaude hit a rate limit. Wait a few minutes and try again.`;
          } else {
            hint = `\n\nResume target: \`${resumeIdHint}\` — verify the session still exists in \`~/.claude/projects/\`.`;
          }
        }
        // Surface BOTH stderr and the parsed stdout error so we never see
        // a silent code-1 again. Tail-truncated so a runaway log doesn't
        // blow up the chat bubble.
        const detailParts: string[] = [];
        if (stderr) detailParts.push(`stderr: ${stderr.slice(-512)}`);
        if (stdoutErr) detailParts.push(`stream: ${stdoutErr.slice(-512)}`);
        if (!stderr && !stdoutErr && lastStdoutLine) {
          // Last-resort: include the raw final stdout line — at least the
          // user (or a follow-up bug report) has something to inspect.
          detailParts.push(`last: ${lastStdoutLine.slice(-512)}`);
        }
        const detail =
          detailParts.length > 0 ? `\n\n\`\`\`\n${detailParts.join('\n').replace(/`/g, "'")}\n\`\`\`` : '';
        this.emit({
          kind: 'error',
          message: `\`${bin}\` exited with code ${code}.${hint}${detail}`
        });
      } else {
        // Clean exit (code 0 / null). Claude in `-p` mode normally emits
        // a `result` line then exits 0 — the result already cleared
        // busy in the reducer. But the CLI can also exit cleanly mid-
        // turn (SIGTERM, OOM-killed, internal abort) WITHOUT a result,
        // leaving the webview's "working…" spinner stuck forever. Emit
        // a synthetic `result` so the reducer flips busy=false; the
        // user can see the agent stopped without a red error if it was
        // a legitimate clean termination.
        this.emit({ kind: 'result', stopReason: 'exit' });
      }
    });
  }

  private onStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return; // ignore non-JSON noise
    }
    for (const update of this.normalizer.parseLine(obj as never)) {
      this.emit(update);
    }
  }

  async prompt(blocks: ContentBlock[]): Promise<void> {
    if (!this.started || !this.proc) {
      this.spawnProcess();
    }
    const line = this.normalizer.encodeUserMessage(blocks);
    this.proc!.stdin.write(line + '\n');
  }

  cancel(): void {
    const proc = this.proc;
    if (!proc) return;
    // Graceful interrupt first: claude treats SIGINT like an interactive
    // Ctrl+C — it aborts the current turn, logs "[Request interrupted by
    // user]", emits a result, and (in -p mode) exits. That path preserves
    // the session for `--resume` on the next prompt.
    try {
      proc.kill('SIGINT');
    } catch {
      /* already dead */
    }
    // Escalation backstop: if the process is wedged badly enough to ignore
    // SIGINT — the stalled-turn case the user reported as "Stop doesn't
    // work" — force-kill after a short grace so control ALWAYS returns. The
    // 'exit' handler then emits a synthetic `result`, flipping the webview
    // out of "working…". Cleared in the exit handler when SIGINT already
    // landed, so a healthy interrupt never gets SIGKILLed.
    if (this.cancelEscalation) clearTimeout(this.cancelEscalation);
    this.cancelEscalation = setTimeout(() => {
      this.cancelEscalation = undefined;
      if (this.proc === proc && this.started) {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* noop */
        }
      }
    }, 2500);
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
    // Claude reads --permission-mode at spawn; a mid-session change takes effect
    // on the next process (re)spawn. Full live mode-switch is wired in P3.
  }

  respondPermission(_requestId: string, _outcome: PermissionOutcome): void {
    // Interactive permission round-trips are wired in P3 (control protocol).
  }

  override dispose(): void {
    super.dispose();
    if (this.cancelEscalation) {
      clearTimeout(this.cancelEscalation);
      this.cancelEscalation = undefined;
    }
    if (this.proc) {
      try {
        this.proc.stdin.end();
      } catch {
        /* noop */
      }
      this.proc.kill();
      this.proc = undefined;
    }
  }
}

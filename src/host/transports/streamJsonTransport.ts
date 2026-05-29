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
      resumeId: this.startOpts!.resumeId ?? this.normalizer.sessionId
    });

    // Curated env: keep subscription auth working, never inject API keys here.
    const env = { ...process.env };

    this.proc = spawn(bin, args, {
      cwd: this.startOpts!.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.started = true;

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => this.onStdoutLine(line));

    this.proc.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString();
      if (text.trim()) {
        console.error(`[code-build:${this.backend}] ${text.trim()}`);
      }
    });

    this.proc.on('error', (err) => {
      this.emit({ kind: 'error', message: `Failed to start ${bin}: ${err.message}` });
    });

    this.proc.on('exit', (code) => {
      this.started = false;
      if (code && code !== 0) {
        this.emit({ kind: 'error', message: `${bin} exited with code ${code}` });
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
    // Closing stdin / SIGINT interrupts the current turn.
    this.proc?.kill('SIGINT');
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

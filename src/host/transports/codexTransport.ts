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
import { CodexNormalizer } from './normalizers/codex';

/**
 * Drives `codex exec --json` — the spawn-per-prompt model: one process per turn,
 * prompt passed as the final argv, NDJSON read until the process exits. Resume uses
 * the captured thread_id via `codex exec resume <id>`.
 */
export class CodexTransport extends BaseAgentSession {
  private proc?: ChildProcessWithoutNullStreams;
  private normalizer = new CodexNormalizer();
  private startOpts?: StartOpts;
  private mode: PermissionMode = 'default';

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
  }

  async prompt(blocks: ContentBlock[]): Promise<void> {
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n').trim();
    const spec = BACKENDS[this.backend];
    const bin = resolveBin(spec, this.binOverrides);
    const baseArgs = spec.buildArgs({
      cwd: this.startOpts!.cwd,
      mode: this.mode,
      model: this.startOpts!.model
    });

    // Resume an existing thread when we have one; otherwise start fresh.
    const args = this.normalizer.threadId
      ? ['exec', 'resume', this.normalizer.threadId, ...baseArgs.slice(1), text]
      : [...baseArgs, text];

    this.proc = spawn(bin, args, {
      cwd: this.startOpts!.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    // Prompt is passed as argv; close stdin so codex doesn't wait on it.
    this.proc.stdin.end();

    this.proc.on('error', (err) =>
      this.emit({ kind: 'error', message: `Failed to start ${bin}: ${err.message}` })
    );
    this.proc.stderr.on('data', (b: Buffer) => {
      const t = b.toString().trim();
      if (t) console.error(`[code-build:codex] ${t}`);
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => this.onLine(line));

    await new Promise<void>((resolve) => {
      this.proc!.on('exit', () => resolve());
    });
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return; // codex also prints non-JSON status lines
    }
    for (const u of this.normalizer.parseLine(obj as never)) this.emit(u);
  }

  cancel(): void {
    this.proc?.kill('SIGINT');
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  respondPermission(_requestId: string, _outcome: PermissionOutcome): void {
    // Codex exec uses sandbox policy rather than interactive prompts; nothing to do.
  }

  override dispose(): void {
    super.dispose();
    this.proc?.kill();
    this.proc = undefined;
  }
}

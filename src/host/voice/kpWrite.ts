// Host-side KP write fallback for Voice Ideation Sessions when the agent
// emits a structured close payload (or when MCP is unavailable).

import { spawn } from 'node:child_process';
import type { VisCloseItem, VisClosePayload } from '../../shared/voiceIdeation';

export interface KpWriteConfig {
  /** Absolute path to knowledge-planning CLI entry (…/src/cli/index.ts). */
  command: string;
  /** Planning store root (KP_ROOT). */
  root: string;
  /** Node executable; defaults to process.execPath. */
  execPath?: string;
  sessionId?: string;
  agent?: string;
  model?: string;
}

export interface KpWriteResult {
  created: string[];
  errors: string[];
  summary?: string;
}

function runKp(
  cfg: KpWriteConfig,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const execPath = cfg.execPath ?? process.execPath;
  return new Promise((resolve) => {
    const child = spawn(execPath, [cfg.command, ...args], {
      env: {
        ...process.env,
        KP_ROOT: cfg.root
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (e) => {
      resolve({ code: 1, stdout, stderr: String(e) });
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function createOne(
  cfg: KpWriteConfig,
  type: 'idea' | 'thought' | 'task',
  item: VisCloseItem
): Promise<{ id?: string; error?: string }> {
  const title = (item.title || 'Untitled').trim().slice(0, 200);
  if (!title) return { error: 'empty title' };

  const args = [
    'create',
    title,
    '--type',
    type,
    '--source',
    'voice-ideation',
    '--tags',
    'voice-ideation,vis'
  ];
  if (item.project) {
    args.push('--project', item.project);
  }
  if (item.priority && type === 'idea') {
    args.push('--priority', item.priority);
  }
  if (cfg.sessionId) {
    args.push('--session', cfg.sessionId);
  }
  if (cfg.agent) {
    args.push('--agent', cfg.agent);
  }
  if (cfg.model) {
    args.push('--model', cfg.model);
  }

  // Body via stdin is not supported by all versions — append via a second
  // path if needed. For now put seed body in title+create and rely on
  // create's optional body flags when present. If body is long, pass as
  // extra create arg when CLI supports --body; otherwise capture fallback.
  const res = await runKp(cfg, args);
  if (res.code !== 0) {
    // Fallback: capture for ideas
    if (type === 'idea' || type === 'thought') {
      const text = item.body ? `${title}\n\n${item.body}` : title;
      const cap = await runKp(cfg, ['capture', text, '--domain', 'tech']);
      if (cap.code === 0) {
        const m = /captured\s+(\S+)/.exec(cap.stdout);
        return { id: m?.[1] ?? cap.stdout.trim() };
      }
      return { error: (res.stderr || res.stdout || cap.stderr || 'create failed').trim() };
    }
    return { error: (res.stderr || res.stdout || 'create failed').trim() };
  }
  const m = /created\s+(\S+)/.exec(res.stdout);
  return { id: m?.[1] ?? res.stdout.trim() };
}

/** Write a VIS close payload into the KP store. */
export async function writeVisClosePayload(
  cfg: KpWriteConfig,
  payload: VisClosePayload
): Promise<KpWriteResult> {
  const created: string[] = [];
  const errors: string[] = [];

  for (const t of payload.thoughts ?? []) {
    const r = await createOne(cfg, 'thought', t);
    if (r.id) created.push(r.id);
    else if (r.error) errors.push(`thought: ${r.error}`);
  }
  for (const idea of payload.ideas ?? []) {
    const r = await createOne(cfg, 'idea', idea);
    if (r.id) created.push(r.id);
    else if (r.error) errors.push(`idea: ${r.error}`);
  }
  for (const task of payload.tasks ?? []) {
    const r = await createOne(cfg, 'task', task);
    if (r.id) created.push(r.id);
    else if (r.error) errors.push(`task: ${r.error}`);
  }

  return { created, errors, summary: payload.summary };
}

export function isKpConfigured(command?: string, root?: string): boolean {
  return Boolean(command?.trim() && root?.trim());
}

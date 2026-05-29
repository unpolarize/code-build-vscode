import type { BackendId } from '../../shared/acpTypes';
import type { AgentSession } from '../agentSession';
import { BACKENDS } from '../backendRegistry';
import { StreamJsonTransport } from './streamJsonTransport';
import { AcpTransport } from './acpTransport';
import { CodexTransport } from './codexTransport';

export interface CreateSessionOpts {
  id: string;
  backend: BackendId;
  binOverrides: Record<string, string>;
}

/** Picks the transport for a backend based on its declared TransportKind. */
export function createSession(opts: CreateSessionOpts): AgentSession {
  const spec = BACKENDS[opts.backend];
  if (spec.transport === 'acp') {
    return new AcpTransport(opts.id, opts.backend, opts.binOverrides);
  }
  if (spec.transport === 'exec-json') {
    return new CodexTransport(opts.id, opts.backend, opts.binOverrides);
  }
  return new StreamJsonTransport(opts.id, opts.backend, opts.binOverrides);
}

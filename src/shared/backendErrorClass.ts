// Backend error classifier (kp: ideas/cb-host-529-overload-cross-acp-failover-on-model).
//
// Maps ACP/stream error text to a failover class so the host can decide
// whether cross-backend failover is even on the table. The contract that
// matters most is the NEGATIVE one: quota/rate-limit (429-class) must
// never classify as overload — quota walls stay with the limit-aware
// switch / Continuity Relay path, and failing over on them would just
// burn a second account's window. Same for auth: a bad key on the
// primary says nothing about backend health.
//
// Pure string/shape matching, no I/O — unit-testable against captured
// fixtures (Claude 529 envelope, Codex "overloaded", Grok "unavailable").

export type BackendErrorClass =
  | 'overload'
  | 'unavailable'
  | 'quota'
  | 'auth'
  | 'other';

/** Loose shape covering the error objects our transports actually see:
 * Anthropic API envelopes ({type:"error",error:{type,message}}), Codex
 * turn.failed errors, raw stderr tails, HTTP-ish {status,code} bags. */
export interface BackendErrorLike {
  message?: string;
  /** Error type/subtype string, e.g. `overloaded_error`, `rate_limit_error`. */
  type?: string;
  /** Numeric or string status/code, e.g. 529, '429', 'ECONNREFUSED'. */
  code?: number | string;
  status?: number | string;
  error?: { type?: string; message?: string };
}

/** True only for classes where spawning a healthy peer backend can help. */
export function isFailoverClass(c: BackendErrorClass): boolean {
  return c === 'overload' || c === 'unavailable';
}

function collectText(input: string | BackendErrorLike): string {
  if (typeof input === 'string') return input;
  return [
    input.type,
    input.message,
    input.error?.type,
    input.error?.message,
    input.code != null ? String(input.code) : '',
    input.status != null ? String(input.status) : ''
  ]
    .filter(Boolean)
    .join(' ');
}

function statusOf(input: string | BackendErrorLike): number | undefined {
  if (typeof input === 'string') return undefined;
  for (const v of [input.status, input.code]) {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 100 && n < 600) {
      return n;
    }
  }
  return undefined;
}

// Order matters: quota and auth are checked BEFORE overload/unavailable.
// Real-world messages mix vocabularies ("429 Too Many Requests: server
// overloaded") and misclassifying a quota wall as overload would
// auto-offer a failover that violates the item's constraints.
// Matched against noisy stderr tails as well as clean API envelopes, so
// generic words stay scoped: no bare `billing`/`credential`, and bare
// `unavailable` only counts within a few words of a backend-ish noun.
const QUOTA_RE =
  /\b429\b|rate.?limit|too many requests|quota|usage limit|spend limit|out of credits|billing (?:error|issue|problem)|limit (?:reached|exceeded)/i;
const AUTH_RE =
  /\b401\b|\b403\b|unauthorized|forbidden|invalid (?:api )?key|authentication|auth(?:orization)? (?:failed|error)|expired token|not logged in|login required|credentials? (?:invalid|expired|rejected|missing)/i;
const OVERLOAD_RE =
  /\b529\b|overloaded(?:_error)?\b|over.?capacity|capacity (?:exceeded|constraints?)|server (?:is )?overloaded/i;
const UNAVAILABLE_RE =
  /\b503\b|\b502\b|model[_ ](?:is[_ ])?(?:currently[_ ])?unavailable|model[_ ]not[_ ]available|service unavailable|temporarily unavailable|\b(?:model|backend|service|api|endpoint|server)\b[^,;\n]{0,60}\bunavailable\b|upstream connect error|no healthy upstream/i;

/** Classify one backend error into the failover taxonomy. */
export function classifyBackendError(
  input: string | BackendErrorLike
): BackendErrorClass {
  const text = collectText(input);
  const status = statusOf(input);

  if (status === 429 || QUOTA_RE.test(text)) return 'quota';
  if (status === 401 || status === 403 || AUTH_RE.test(text)) return 'auth';
  if (status === 529 || OVERLOAD_RE.test(text)) return 'overload';
  if (status === 502 || status === 503 || UNAVAILABLE_RE.test(text)) {
    return 'unavailable';
  }
  return 'other';
}

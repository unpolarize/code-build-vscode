// Voice Ideation Session (VIS) facilitation contracts and close prompts.
// Shared between host (sessionManager) and webview (slash commands / UI).

export type SessionKind = 'coding' | 'voice-ideation';

export type VoiceMode = 'off' | 'dictation' | 'interactive' | 'ideation';

/** System/facilitation preamble prepended once at VIS start. */
export function visFacilitationPreamble(sessionId: string): string {
  return [
    '# Voice Ideation Session (VIS)',
    '',
    'You are facilitating a **voice ideation session**. The user is speaking freely',
    '(dictation / hands-free). Your job is to help them think out loud and leave',
    'durable planning objects — not to edit the codebase.',
    '',
    '## Contract',
    '1. **Listen first** — do not force structure on turn 1; mirror what you heard.',
    '2. **Mirror problems** as testable statements (not moods).',
    '3. **Map** each implementable slice to one project when possible',
    '   (KP, CB, CSV, CS, otelo, unpolarize, docs-kb, career, life…).',
    '4. **Separate** life/mood from tech slices; life stays as a thought unless asked.',
    '5. Prefer short spoken-friendly replies (2–6 sentences) while they ramble;',
    '   expand structure when they pause or ask to capture.',
    '6. **Do not edit the repo** unless the user explicitly asks. Prefer KP tools',
    '   (`kp_create`, `kp_search`, `kp_link_session`) when available.',
    '7. Provenance for every object: `source: voice-ideation`, session `' +
      sessionId +
      '`.',
    '',
    '## During the session',
    '- Periodically reflect: numbered problems, candidate solutions, project map.',
    '- Accept steers: "skip 2", "that\'s a KP problem not CB", "save that as a thought".',
    '- If they say "close session" / "wrap up" / "save this", run the close checklist.',
    '',
    '## Close checklist (when ending)',
    '1. Optional thought: raw dump summary of the ramble.',
    '2. One or more ideas with ## Problem / ## Solution shape / ## Seed (quotes).',
    '3. Optional tasks only if clearly actionable and confirmed.',
    '4. One-line session summary.',
    '5. If KP tools are available, create the objects. If not, emit a final fenced',
    '   JSON block the host can parse:',
    '```json',
    '{',
    '  "thoughts": [{"title": "...", "body": "..."}],',
    '  "ideas": [{"title": "...", "body": "...", "project": "projects/<slug>", "priority": "p2"}],',
    '  "tasks": [{"title": "...", "body": "...", "project": "projects/<slug>"}],',
    '  "summary": "one line"',
    '}',
    '```',
    '',
    'Start by greeting briefly and inviting them to ramble — what is on their mind?'
  ].join('\n');
}

/** Prompt sent when the user ends a VIS (button / slash / voice command). */
export function visClosePrompt(sessionId: string): string {
  return [
    'Please **close this Voice Ideation Session** now.',
    '',
    `Session id: \`${sessionId}\`.`,
    '',
    '1. Summarize the ramble in 2–4 sentences (spoken-friendly).',
    '2. List problems you heard (numbered, testable).',
    '3. Create durable KP objects with source `voice-ideation` and this session id:',
    '   - optional thought (raw dump)',
    '   - ≥1 idea (or say "nothing to capture" if truly empty)',
    '   - optional tasks only if confirmed actionable',
    '4. Use kp tools if available; otherwise end with the fenced JSON close payload',
    '   described in the VIS contract so the host can write the store.',
    '5. End with a one-line session summary for a daily report.'
  ].join('\n');
}

/** Spoken close phrases that should trigger VIS end from dictation. */
export const VIS_CLOSE_PHRASES = [
  'close session',
  'end session',
  'wrap up',
  'wrap this up',
  'save this session',
  'end ideation',
  'close ideation',
  "that's all for now",
  'thats all for now'
];

export function isVisClosePhrase(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.,!?]+$/g, '');
  return VIS_CLOSE_PHRASES.some((p) => t === p || t.endsWith(p) || t.includes(p));
}

/** Strip markdown noise so TTS reads naturally. */
export function textForSpeech(raw: string, maxChars = 1200): string {
  let s = raw;
  // Fenced code blocks → short marker
  s = s.replace(/```[\s\S]*?```/g, ' (code omitted) ');
  // Inline code
  s = s.replace(/`([^`]+)`/g, '$1');
  // Links [label](url) → label
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Headings / emphasis
  s = s.replace(/^#{1,6}\s+/gm, '');
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');
  s = s.replace(/(\*|_)(.*?)\1/g, '$2');
  // Bullet markers
  s = s.replace(/^\s*[-*+]\s+/gm, '');
  s = s.replace(/^\s*\d+\.\s+/gm, '');
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxChars) {
    s = s.slice(0, maxChars).replace(/\s+\S*$/, '') + '…';
  }
  return s;
}

/** Parse a VIS close JSON payload from assistant text (last ```json fence preferred). */
export function parseVisClosePayload(text: string): VisClosePayload | null {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const body = fences[i][1]?.trim();
    if (!body) continue;
    try {
      const obj = JSON.parse(body) as VisClosePayload;
      if (obj && (obj.ideas || obj.thoughts || obj.tasks || obj.summary)) {
        return {
          thoughts: Array.isArray(obj.thoughts) ? obj.thoughts : [],
          ideas: Array.isArray(obj.ideas) ? obj.ideas : [],
          tasks: Array.isArray(obj.tasks) ? obj.tasks : [],
          summary: typeof obj.summary === 'string' ? obj.summary : undefined
        };
      }
    } catch {
      /* try previous fence */
    }
  }
  // Bare object fallback
  const bare = text.match(/\{\s*"(?:thoughts|ideas|tasks|summary)"[\s\S]*\}/);
  if (bare) {
    try {
      const obj = JSON.parse(bare[0]) as VisClosePayload;
      if (obj && (obj.ideas || obj.thoughts || obj.tasks || obj.summary)) {
        return {
          thoughts: Array.isArray(obj.thoughts) ? obj.thoughts : [],
          ideas: Array.isArray(obj.ideas) ? obj.ideas : [],
          tasks: Array.isArray(obj.tasks) ? obj.tasks : [],
          summary: typeof obj.summary === 'string' ? obj.summary : undefined
        };
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

export interface VisCloseItem {
  title: string;
  body?: string;
  project?: string;
  priority?: string;
}

export interface VisClosePayload {
  thoughts?: VisCloseItem[];
  ideas?: VisCloseItem[];
  tasks?: VisCloseItem[];
  summary?: string;
}

// Built-in slash commands that are always available, independent of the backend.
// Agent-provided commands (e.g. grok's /compact) are merged after these and are
// forwarded to the agent as a normal prompt.

export interface BuiltinCommand {
  name: string;
  description: string;
  builtin: true;
}

export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  { name: 'new', description: 'Start a new conversation', builtin: true },
  { name: 'clear', description: 'Clear the messages in this view', builtin: true },
  { name: 'history', description: 'Browse previous conversations', builtin: true },
  { name: 'tab', description: 'Open this chat in a new editor tab', builtin: true },
  { name: 'window', description: 'Open this chat in a new window', builtin: true },
  { name: 'perf', description: 'Toggle Session Performance panel (HUD / waterfall / events)', builtin: true },
  { name: 'handoff', description: 'Write a HANDOFF.md pack for continuing this work on another agent', builtin: true }
];

export const BUILTIN_NAMES = new Set(BUILTIN_COMMANDS.map((c) => c.name));

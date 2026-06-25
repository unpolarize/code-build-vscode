const COMMAND_WRAPPER_RE =
  /<(command-message|command-name|command-args|command-contents|system-reminder|local-command-stdout|local-command-stderr|command-output)>[\s\S]*?<\/\1>/gi;

/**
 * Strip Claude Code slash-command / harness wrapper tags from a user message so
 * titles aren't `<command-message>load</command-message>…`. For a `/command`
 * invocation, return a readable `"<name> <args>"` (e.g. `/load review …`);
 * otherwise drop the known wrapper blocks and keep the real prompt text.
 */
export function cleanCommandText(text: string): string {
  if (!text) return text;
  const nameTag = /<command-name>\s*([\s\S]*?)\s*<\/command-name>/i.exec(text)?.[1]?.trim();
  const msgTag = /<command-message>\s*([\s\S]*?)\s*<\/command-message>/i.exec(text)?.[1]?.trim();
  const name = nameTag || (msgTag ? `/${msgTag.replace(/^\//, '')}` : undefined);
  if (name) {
    const args = /<command-args>\s*([\s\S]*?)\s*<\/command-args>/i.exec(text)?.[1]?.trim() ?? '';
    return (args ? `${name} ${args}` : name).trim();
  }
  return text.replace(COMMAND_WRAPPER_RE, '').trim();
}

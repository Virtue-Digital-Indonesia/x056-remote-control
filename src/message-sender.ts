/** Display attribution, carried with the prompt so either provider retains it. */
export interface MessageSender {
  messageId?: string;
  kind: 'conversation' | 'automation' | 'autopilot' | 'mcp' | 'advisor' | 'delegate';
  projectId?: string;
  sessionId?: string;
  projectName?: string;
  conversationTitle?: string;
}
const MARKER = '\n\n[x056 message sender v1] ';
export function withMessageSender(text: string, sender?: MessageSender): string {
  // Commands must reach the provider byte-for-byte, without appended arguments.
  return sender && !text.trimStart().startsWith('/') ? text + MARKER + JSON.stringify(sender) : text;
}
export function readMessageSender(text: string): { text: string; sender?: MessageSender } {
  const index = text.lastIndexOf(MARKER);
  if (index < 0 || text.length - index > 8000) return { text };
  try {
    const raw = JSON.parse(text.slice(index + MARKER.length));
    if (!raw || !['conversation', 'automation', 'autopilot', 'mcp', 'advisor', 'delegate'].includes(raw.kind)) return { text };
    const sender: MessageSender = { kind: raw.kind };
    for (const key of ['messageId', 'projectId', 'sessionId', 'projectName', 'conversationTitle'] as const) {
      if (raw[key] !== undefined) {
        if (typeof raw[key] !== 'string' || raw[key].length > 1000) return { text };
        sender[key] = raw[key];
      }
    }
    return { text: text.slice(0, index), sender };
  } catch { return { text }; }
}

/**
 * The agent team's per-turn line ("[Agent team this turn: ...]"), appended to
 * the prompt the CLI receives and stripped wherever the gateway reads a prompt
 * back. It rides in the MESSAGE because the system prompt and the agent
 * definitions are process identity: a per-turn value there would respawn the
 * process every turn. It sits before the sender marker, which must stay last.
 */
export const TEAM_LINE_PREFIX = '[Agent team this turn: ';
/** The advisor's per-turn line (Claude, advisor on), same mechanism. */
export const ADVISOR_LINE_PREFIX = '[Advisor on: ';
// Either line, or both stacked, at the end (before the sender marker).
const TEAM_LINE = /(?:\n\n\[(?:Agent team this turn|Advisor on): [^\n]*\])+\s*$/;
export function withTeamLine(text: string, line: string | undefined): string {
  if (!line || text.trimStart().startsWith('/')) return text;
  const r = readMessageSender(text);
  return r.sender ? r.text + '\n\n' + line + text.slice(r.text.length) : text + '\n\n' + line;
}
/** Removes the team line and the advisor line (whichever are there). */
export function stripTeamLine(text: string): string {
  return text.replace(TEAM_LINE, '');
}

/** Display attribution, carried with the prompt so either provider retains it. */
export interface MessageSender {
  messageId?: string;
  /** `bot_event`: a digest of things that need the owner, handed to the Bot.
   *  `bot_brief`: the Bot's morning brief prompt.
   *  `limit_resume`: the gateway continuing the owner's work after a usage
   *  limit. Not an agent: it stays visible in the owner view and the Bot view. */
  kind: 'conversation' | 'automation' | 'autopilot' | 'mcp' | 'advisor' | 'delegate' | 'recap' | 'bot_event' | 'bot_brief' | 'limit_resume';
  /** For kind `recap`: which ending the gateway asked for. */
  recap?: 'background' | 'autopilot';
  /** For kind `limit_resume`: the origin of the turn it continues (cron,
   *  relay, delegate, ...); absent = the owner's. Its ending notifies as that
   *  turn would have. Read by the gateway only, never parsed back from text. */
  resumeOf?: string;
  projectId?: string;
  sessionId?: string;
  projectName?: string;
  conversationTitle?: string;
}
const MARKER = '\n\n[x056 message sender v1] ';
const SENDER_KINDS: readonly string[] = ['conversation', 'automation', 'autopilot', 'mcp', 'advisor', 'delegate', 'recap', 'bot_event', 'bot_brief', 'limit_resume'];
export function withMessageSender(text: string, sender?: MessageSender): string {
  // Commands must reach the provider byte-for-byte, without appended arguments.
  return sender && !text.trimStart().startsWith('/') ? text + MARKER + JSON.stringify(sender) : text;
}
export function readMessageSender(text: string): { text: string; sender?: MessageSender } {
  const index = text.lastIndexOf(MARKER);
  if (index < 0 || text.length - index > 8000) return { text };
  try {
    const raw = JSON.parse(text.slice(index + MARKER.length));
    if (!raw || !SENDER_KINDS.includes(raw.kind)) return { text };
    const sender: MessageSender = { kind: raw.kind };
    if (raw.recap !== undefined) {
      if (raw.recap !== 'background' && raw.recap !== 'autopilot') return { text };
      sender.recap = raw.recap;
    }
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
const TEAM_LINE = /(?:\n\n\[(?:Agent team this turn|Advisor on|Open question to the owner, still unanswered|Hidden from the owner): [^\n]*\])+\s*$/;
export function withTeamLine(text: string, line: string | undefined): string {
  if (!line || text.trimStart().startsWith('/')) return text;
  const r = readMessageSender(text);
  return r.sender ? r.text + '\n\n' + line + text.slice(r.text.length) : text + '\n\n' + line;
}
/** The open-question line: a turn (the owner's own included) arrives while a
 *  question to the owner is still unanswered, and may close it with the
 *  RESOLVED marker. Same mechanism as the team line (the message, never the
 *  system prompt). */
export const OPEN_QUESTION_LINE_PREFIX = '[Open question to the owner, still unanswered: ';
export function openQuestionLine(questions: string[]): string {
  const one = (q: string) => '"' + q.replace(/\s+/g, ' ').trim().slice(0, 300).replace(/"/g, "'") + '"';
  return `${OPEN_QUESTION_LINE_PREFIX}${questions.slice(0, 6).map(one).join(', ')}. Only if THIS message gives the owner's answer or makes the question moot, end your reply with <<<RESOLVED>>> on its own line. Never add it as a sign-off or while you still need the owner's answer.]`;
}
/** Removes the team line, the advisor line and the open-question line (whichever are there). */
export function stripTeamLine(text: string): string {
  return text.replace(TEAM_LINE, '');
}

/** The per-turn line on a turn another conversation / MCP / delegate / schedule started. */
export const OWNER_HIDDEN_LINE_PREFIX = '[Hidden from the owner: ';
export const OWNER_HIDDEN_LINE = OWNER_HIDDEN_LINE_PREFIX + 'the owner does not see this turn or your reply unless you mark it. If your reply is for the owner or needs them (for example it reports finished work they asked for), put <<<FOR_OWNER>>> on its own line, or end with an ASK block for a decision.]';

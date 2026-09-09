/** Display attribution, carried with the prompt so either provider retains it. */
export interface MessageSender {
  messageId?: string;
  kind: 'conversation' | 'automation' | 'autopilot' | 'mcp';
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
    if (!raw || !['conversation', 'automation', 'autopilot', 'mcp'].includes(raw.kind)) return { text };
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

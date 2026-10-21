// The Bot's own MCP tools (docs/bot-v0-contract.md). Listed ONLY when the
// bridge runs inside a Bot turn (X056_BOT=1, set by the manager's per-turn MCP
// config), and refused otherwise; the gateway routes behind them re-check that
// the caller (`from`) is a conversation of the Bot either way. Kept out of
// TOOLS on purpose: every other conversation and every external client sees
// the same surface as before.
const str = { type: 'string' }, bool = { type: 'boolean' };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });

export const BOT_TOOLS = [
  {
    name: 'message_owner',
    description:
      'Say something to the owner, in the Bot chat. Only the Bot has this tool. Without needs_you it is an FYI: the owner sees it as an unread message from you, with no push. '
      + 'With needs_you: true it asks for a decision: it becomes a question card for the owner and is pushed as urgent (several asks wait together; ask each thing once). '
      + 'Use it to reach the owner from a turn they did not start: an agent\'s message, a digest, a scheduled task, a delegate report. '
      + 'A reply to an agent that messaged you goes back to that agent and is hidden from the owner, so use this tool when the owner must know. Do not use it to acknowledge a message the owner wrote to you: they read your normal reply.',
    inputSchema: object({
      text: { type: 'string', minLength: 1, maxLength: 8000, description: 'what you want the owner to read, in plain words; for needs_you give the context and the question' },
      needs_you: { type: 'boolean', description: 'true = a decision only the owner can make (pushed, shows as needs-me); false or absent = FYI' },
      options: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 8, description: 'quick replies for a needs_you question' },
    }, ['text']),
    outputSchema: object({ ok: bool, id: str, needs_you: bool }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'notify_user',
    description:
      'The older name of message_owner (same effect). urgent: true = message_owner with needs_you (a question card, pushed); without urgent it is an FYI message in the Bot chat with no push. '
      + 'Use urgent: true when the owner must act now: a decision they must make, with its context; a failure; or an action that needs them. '
      + 'The gateway already pushed each urgent item on its own, so never repeat one, and never notify twice for the same thing. '
      + 'link: an optional panel path starting with / (for example /chat/<id>), added to the message; anything else is dropped.',
    inputSchema: object({
      title: { type: 'string', minLength: 1, maxLength: 200, description: 'short headline, under 60 characters reads best' },
      body: { type: 'string', maxLength: 4000, description: 'what happened and what you need, in plain words' },
      urgent: { type: 'boolean', description: 'true = a needs-you question, pushed now; false or absent = FYI in the Bot chat' },
      link: { type: 'string', description: 'panel path starting with /' },
    }, ['title', 'body']),
    outputSchema: object({ ok: bool, id: str, tier: { type: 'string', enum: ['urgent', 'normal'] }, link: str }, ['ok', 'id', 'tier']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'status_overview',
    description:
      'One cheap snapshot of the gateway for the owner\'s assistant: what needs the owner (pending questions and approvals), what is running (turns and background work), '
      + 'notable events of the last 24 hours (newest first), active delegates, scheduled tasks whose last run failed, and each account\'s state and limit reset. Only the Bot has this tool. Call it first for a brief or a check-in.',
    inputSchema: object({}, []),
    outputSchema: object({ overview: { type: 'object', additionalProperties: true } }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

export const BOT_TOOL_NAMES = new Set(BOT_TOOLS.map((t) => t.name));

export async function callBotTool(api, name, args, self) {
  if (!self.sessionId) throw new Error(name + ' is only available to the Bot');
  if (name === 'message_owner') {
    const r = await api('/api/bot/message', { method: 'POST', body: JSON.stringify({ from: self.sessionId, text: args.text, ...(args.needs_you ? { needsYou: true } : {}), ...(Array.isArray(args.options) && args.options.length ? { options: args.options } : {}) }) });
    const out = { ok: !!r?.ok, id: String(r?.id ?? ''), needs_you: !!r?.needsYou };
    return { content: [{ type: 'text', text: out.needs_you ? 'Asked the owner (needs you): a question card is open and pushed.' : 'Posted to the Bot chat as an FYI (unread for the owner, not pushed).' }], structuredContent: out };
  }
  if (name === 'notify_user') {
    const r = await api('/api/bot/notify', { method: 'POST', body: JSON.stringify({ from: self.sessionId, title: args.title, body: args.body, tier: args.urgent ? 'urgent' : 'normal', ...(args.link ? { link: args.link } : {}) }) });
    const out = { ok: !!r?.ok, id: String(r?.id ?? ''), tier: r?.tier === 'urgent' ? 'urgent' : 'normal', ...(r?.link ? { link: r.link } : {}) };
    return { content: [{ type: 'text', text: `${out.tier === 'urgent' ? 'Asked the owner (needs you): a question card is open and pushed.' : 'Posted to the Bot chat as an FYI (unread for the owner, not pushed; use urgent: true to ask).'}${args.link && !out.link ? ' The link was dropped: it must be a panel path starting with /.' : ''}` }], structuredContent: out };
  }
  if (name === 'status_overview') {
    const overview = await api('/api/bot/overview?' + new URLSearchParams({ from: self.sessionId }));
    return { content: [{ type: 'text', text: JSON.stringify(overview, null, 2) }], structuredContent: { overview } };
  }
  throw new Error('unknown Bot tool: ' + name);
}

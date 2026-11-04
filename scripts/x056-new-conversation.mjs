// The new-conversation guard, shared by the MCP bridge (bare node) and the
// gateway (server/new-conversation-guard.ts imports it). The owner's rule
// (2026-10-28): when MCP creates a new conversation the caller must choose the
// provider, model, effort and whether the agent team is on, explicitly, so it
// actually thinks about it. Since 2026-11-04 (Efran) also its title. The gateway is the enforcement; the bridge runs the
// same check first so the AI gets the same message without a round trip.

export const PROVIDERS = ['claude', 'codex'];
/** What the panel offers on Claude (panel.html model select), and Jev's candidates. */
export const CLAUDE_MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
/** The panel's Claude effort select (Auto excluded). */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
/** Used only when no Codex account has a catalog cached yet. */
export const CODEX_FALLBACK_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

const CLAUDE_ALIAS = new RegExp(`^(${CLAUDE_MODELS.join('|')})(\\[1m\\])?$`, 'i');
const CLAUDE_FULL_ID = /^claude-[a-z0-9][a-z0-9.-]*(\[1m\])?$/i;
const CODEX_SHAPE = /^(gpt-|codex-)/i;
/** The longest title a new conversation may be given here. */
export const TITLE_MAX = 120;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const absent = (v) => v === undefined || v === null || v === '';
const isAuto = (v) => typeof v === 'string' && v.trim().toLowerCase() === 'auto';

/**
 * Check one new-conversation choice.
 *
 * `opts.codexModels`: the live Codex catalog (`[{slug, efforts}]`). Undefined =
 * unknown here (the bridge): Codex model and effort membership is then left to
 * the gateway. An empty array = no account has cached one yet: the model must
 * look like a Codex id and the effort is checked against a generic list.
 * `opts.mapCodex(model, effort)`: maps a legacy Codex id forward before the
 * catalog lookup (the gateway passes `currentCodexPrefs`).
 * `opts.teamField`: how the caller names the team flag, for the message.
 * `opts.titleField`: how the caller names the title (create_chat: `name`).
 * `opts.codexList`: a catalog used only to LIST Codex choices in the message
 * (the bridge has the panel's list but not the legacy-id mapping, so it does
 * not judge membership with it).
 *
 * Returns `{ ok: true, choice }` or `{ ok: false, problems, message }`.
 */
export function checkNewConversationChoice(input, opts = {}) {
  const { provider, model, effort, team, title } = input ?? {};
  const teamField = opts.teamField ?? 'team';
  const titleField = opts.titleField ?? 'title';
  const missing = [];
  const invalid = [];
  if (absent(provider)) missing.push('provider');
  else if (!PROVIDERS.includes(provider)) invalid.push(`provider ${JSON.stringify(provider)}`);
  if (absent(model)) missing.push('model');
  else if (typeof model !== 'string') invalid.push('model (must be a string)');
  else if (isAuto(model)) invalid.push('model "auto" (pick a concrete model)');
  if (absent(effort)) missing.push('effort');
  else if (typeof effort !== 'string') invalid.push('effort (must be a string)');
  else if (isAuto(effort)) invalid.push('effort "auto" (pick a concrete level)');
  if (team === undefined || team === null) missing.push(teamField);
  else if (typeof team !== 'boolean') invalid.push(`${teamField} (must be true or false)`);
  if (absent(title)) missing.push(titleField);
  else if (typeof title !== 'string') invalid.push(`${titleField} (must be a string)`);
  else if (!title.trim()) invalid.push(`${titleField} (empty after trimming)`);
  else if (CONTROL_CHARS.test(title)) invalid.push(`${titleField} (one line, no control characters)`);
  else if (title.trim().length > TITLE_MAX) invalid.push(`${titleField} (at most ${TITLE_MAX} characters)`);

  const providerOk = PROVIDERS.includes(provider);
  const modelOk = typeof model === 'string' && !absent(model) && !isAuto(model);
  const effortOk = typeof effort === 'string' && !absent(effort) && !isAuto(effort);
  const catalog = Array.isArray(opts.codexModels) ? opts.codexModels.filter((m) => m && typeof m.slug === 'string') : undefined;

  if (providerOk && provider === 'claude') {
    if (modelOk && !(CLAUDE_ALIAS.test(model) || CLAUDE_FULL_ID.test(model))) invalid.push(`model ${JSON.stringify(model)} for claude`);
    if (effortOk && !CLAUDE_EFFORTS.includes(effort)) invalid.push(`effort ${JSON.stringify(effort)} for claude`);
  }
  if (providerOk && provider === 'codex') {
    if (modelOk && (CLAUDE_ALIAS.test(model) || CLAUDE_FULL_ID.test(model))) invalid.push(`model ${JSON.stringify(model)} for codex (that is a Claude model)`);
    else if (modelOk && catalog) {
      const mapped = opts.mapCodex ? opts.mapCodex(model, effort || '').model : model;
      const entry = catalog.length ? catalog.find((m) => m.slug === mapped) : undefined;
      if (catalog.length ? !entry : !CODEX_SHAPE.test(model)) invalid.push(`model ${JSON.stringify(model)} for codex`);
      else if (effortOk) {
        const levels = entry?.efforts?.length ? entry.efforts : CODEX_FALLBACK_EFFORTS;
        if (!levels.includes(effort)) invalid.push(`effort ${JSON.stringify(effort)} for ${mapped}`);
      }
    }
  }

  if (!missing.length && !invalid.length) return { ok: true, choice: { provider, model, effort, team, title: title.trim() } };
  const parts = [];
  if (missing.length) parts.push(`missing ${missing.join(', ')}`);
  if (invalid.length) parts.push(`invalid ${invalid.join('; ')}`);
  return { ok: false, problems: [...missing.map((m) => `missing ${m}`), ...invalid.map((i) => `invalid ${i}`)], message: newConversationMessage(parts.join('; '), providerOk ? provider : undefined, catalog ?? opts.codexList, teamField, titleField) };
}

/** The text an AI reads: what is wrong, then every valid choice for the
 *  provider it picked (both providers when it picked none), so it can correct
 *  itself in one retry. */
export function newConversationMessage(what, provider, codexModels, teamField = 'team', titleField = 'title') {
  const lines = [`New conversation needs explicit choices: ${what}.`, 'provider: claude|codex.'];
  if (provider !== 'codex') {
    lines.push(`Claude models: ${CLAUDE_MODELS.join(', ')} (or a full claude-* id).`);
    lines.push(`Claude efforts: ${CLAUDE_EFFORTS.join(', ')}.`);
  }
  if (provider !== 'claude') {
    if (codexModels?.length) lines.push(`Codex models (efforts): ${codexModels.map((m) => `${m.slug} (${(m.efforts?.length ? m.efforts : CODEX_FALLBACK_EFFORTS).join('|')})`).join(', ')}.`);
    else if (codexModels) lines.push(`Codex models: no catalog cached yet, so any gpt-* id; efforts: ${CODEX_FALLBACK_EFFORTS.join(', ')}.`);
    else lines.push('Codex models and efforts: the live catalog (GET /api/models); the gateway checks them.');
  }
  lines.push(`${teamField}: true|false (agent team).`);
  lines.push(`${titleField}: the conversation's title, 1-${TITLE_MAX} characters on one line (kept; never auto-retitled).`);
  return lines.join(' ');
}

import { BadRequestException } from '@nestjs/common';
import { getAdapter } from '../src/adapters/registry.js';
import { currentCodexPrefs } from '../src/codex-model-policy.js';
import { checkNewConversationChoice, type CodexCatalogEntry, type NewConversationChoice, type NewConversationChoiceInput } from '../scripts/x056-new-conversation.mjs';

export type { NewConversationChoice } from '../scripts/x056-new-conversation.mjs';

/**
 * The owner's rule (2026-10-28): a conversation created through MCP must name
 * its provider, model, effort and whether the agent team is on, explicitly.
 * Enforced at the routes MCP uses to create one (`/api/conversations/send`
 * without a sessionId, `/api/chats` with the MCP marker, `/api/cron` for a
 * new-conversation job), never in the shared delivery path, so approvals
 * already waiting, legacy cron jobs and internal sends are unaffected.
 */

const CATALOG_TTL_MS = 5_000;
let cached: { key: string; at: number; models: CodexCatalogEntry[] } | undefined;

/** The Codex catalog the panel's picker shows (`GET /api/models`), merged over
 *  every Codex account's cache. Re-read at most every 5 s. */
export function codexCatalog(configDirs: string[], now = Date.now()): CodexCatalogEntry[] {
  const key = configDirs.join('\0');
  if (cached && cached.key === key && now - cached.at < CATALOG_TTL_MS) return cached.models;
  let models: CodexCatalogEntry[] = [];
  try { models = (getAdapter('codex').listModels?.(configDirs) ?? []).map((m) => ({ slug: m.slug, efforts: m.efforts })); }
  catch { models = []; }
  cached = { key, at: now, models };
  return models;
}

/** Throws a 400 listing what is missing or invalid and every valid choice. */
export function requireNewConversationChoice(input: NewConversationChoiceInput, codexModels: CodexCatalogEntry[], teamField = 'team'): NewConversationChoice {
  const out = checkNewConversationChoice(input, { codexModels, mapCodex: currentCodexPrefs, teamField });
  if (!out.ok) throw new BadRequestException(out.message);
  return out.choice;
}

// Transcript reading now lives with the provider whose format it is — Claude's
// projects/*.jsonl shape is Claude-specific (see src/adapters/claude.ts);
// Codex's own sessions/rollout-*.jsonl reader lives in src/adapters/codex.ts.
// Re-exported here so existing imports keep working: findTranscript is still
// used directly by the manager's session-ADOPTION check (a Claude-only concept
// — there's no interactive-session-adoption equivalent for Codex).
export type { HistoryEntry } from '../src/provider.js';
export { findTranscript, readHistory as readSessionHistory } from '../src/adapters/claude.js';

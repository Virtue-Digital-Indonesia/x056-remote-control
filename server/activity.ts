// Activity mapping now lives with the provider that produces the events — the
// Claude stream-json shape is Claude-specific. Re-exported here so existing
// imports (`server/manager.ts`, tests) keep working while the manager is still
// hardwired to Claude; once it selects an adapter per session (Phase 4) it will
// call `adapter.toActivity` directly and this shim can go away.
export type { ActivityEvent } from '../src/provider.js';
export { claudeAdapter } from '../src/adapters/claude.js';
import { claudeAdapter } from '../src/adapters/claude.js';
import type { RawEvent } from '../src/types.js';
import type { ActivityEvent } from '../src/provider.js';

export function toActivity(e: RawEvent): ActivityEvent[] {
  return claudeAdapter.toActivity(e);
}

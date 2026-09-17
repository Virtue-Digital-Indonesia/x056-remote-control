import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectRegistry } from '../server/projects.js';

describe('conversation outcomes', () => {
  it('clears a recorded outcome once, keeps the conversation, and refuses unknown ids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-outcome-'));
    const reg = ProjectRegistry.load(join(dir, 'projects.json'));
    const p = reg.create('Repo', dir);
    reg.addConversation(p.id, 'sid-1', 'Failed run', 'codex');
    reg.recordOutcome(p.id, 'sid-1', { status: 'failed', at: new Date().toISOString(), reason: 'signal SIGKILL' });
    expect(reg.get(p.id)!.conversations![0].lastOutcome?.status).toBe('failed');
    expect(reg.clearOutcome(p.id, 'sid-1')).toBe(true);
    expect(reg.get(p.id)!.conversations![0].lastOutcome).toBeUndefined();
    expect(reg.get(p.id)!.conversations![0].title).toBe('Failed run');
    expect(reg.clearOutcome(p.id, 'sid-1')).toBe(false); // nothing left to clear
    expect(() => reg.clearOutcome(p.id, 'nope')).toThrow('Conversation not found');
    // The cleared state is what a reload sees.
    expect(ProjectRegistry.load(join(dir, 'projects.json')).get(p.id)!.conversations![0].lastOutcome).toBeUndefined();
  });
});

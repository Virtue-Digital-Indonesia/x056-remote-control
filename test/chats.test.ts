import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionManager } from '../server/manager.js';
import { ProjectRegistry } from '../server/projects.js';
import { AccountRegistry } from '../src/accounts.js';
import type { RunSessionOptions } from '../src/failover.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rc-chats-')), stateDir = join(dir, 'state'), workspaceRoot = join(dir, 'workspace');
  mkdirSync(stateDir); mkdirSync(workspaceRoot);
  AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: join(dir, 'a') }]);
  const calls: RunSessionOptions[] = [];
  const options = { stateDir, workspaceRoot, chatEnabled: true, runSessionFn: async (o: RunSessionOptions) => {
    calls.push(o);
    return { status: 'completed' as const, sessionId: o.sessionId, providerSessionId: o.sessionId, account: 'a', failovers: 0 };
  } };
  return { dir, stateDir, workspaceRoot, calls, options, manager: new SessionManager(options) };
}

describe('Chat identity', () => {
  it('prepares stable identities, keeps files across restart, and starts then resumes the same session', async () => {
    const f = fixture(), input = { requestId: 'chat-create-001', name: 'Proposal' };
    const a = f.manager.createChat(input), b = f.manager.createChat({ requestId: 'chat-create-002' });
    expect(f.manager.createChat(input).id).toBe(a.id);
    expect(() => f.manager.createChat({ ...input, name: 'Changed' })).toThrow('requestId');
    expect(a.lastSessionId).not.toBe(b.lastSessionId);
    writeFileSync(join(a.cwd, 'proposal.txt'), 'original');
    const restarted = new SessionManager(f.options);
    expect(readFileSync(join(restarted.chat(a.id).cwd, 'proposal.txt'), 'utf8')).toBe('original');
    expect(restarted.start('Read proposal', undefined, undefined, a.id)).toBe(a.lastSessionId);
    await new Promise(r => setTimeout(r, 10));
    restarted.continueSession(a.id, a.lastSessionId!, 'Continue');
    expect(f.calls.map(c => c.resume)).toEqual([false, true]);
    expect(f.calls.map(c => c.cwd)).toEqual([a.cwd, a.cwd]);
    await new Promise(r => setTimeout(r, 10));
    restarted.updateChat(a.id, { name: 'Final proposal', archived: true });
    expect(() => restarted.continueSession(a.id, a.lastSessionId!, 'again')).toThrow('archived');
    expect(readFileSync(join(a.cwd, 'proposal.txt'), 'utf8')).toBe('original');
    restarted.updateChat(a.id, { archived: false });
    expect(restarted.chat(a.id).conversations?.[0].title).toBe('Final proposal');
  });

  it('enforces one conversation and keeps ordinary projects separate', () => {
    const f = fixture(), chat = f.manager.createChat({ requestId: 'chat-create-003' });
    const reg = ProjectRegistry.load(join(f.stateDir, 'projects.json'));
    expect(() => reg.addConversation(chat.id, 'other', 'Other')).toThrow('one conversation');
    expect(() => reg.setLastSession(chat.id, 'other')).toThrow('one conversation');
    expect(() => reg.remove(chat.id)).toThrow('Archive');
    expect(() => reg.removeConversation(chat.id, chat.lastSessionId!)).toThrow('Archive');
    expect(() => reg.setProvider(chat.id, 'codex')).toThrow('another provider');
    expect(() => f.manager.createProject('state access', f.stateDir)).toThrow('outside workspace');
    expect(() => f.manager.createProject('Chat reuse', chat.cwd)).toThrow('outside workspace');
    const project = f.manager.createProject('Ordinary');
    expect(project.cwd).toBe(f.workspaceRoot);
    expect(project.kind).toBeUndefined();
    expect(() => new SessionManager({ ...f.options, chatEnabled: false }).chat(chat.id)).toThrow('disabled');
  });

  it('rejects a redirected Chat root even if its target is otherwise allowed', () => {
    const f = fixture(), chat = f.manager.createChat({ requestId: 'chat-create-004' });
    const data = JSON.parse(readFileSync(join(f.stateDir, 'projects.json'), 'utf8'));
    const link = join(f.workspaceRoot, 'redirect'); symlinkSync(chat.cwd, link);
    data.projects.find((p: { id: string }) => p.id === chat.id).cwd = link;
    writeFileSync(join(f.stateDir, 'projects.json'), JSON.stringify(data));
    expect(() => f.manager.chat(chat.id)).toThrow('Invalid Chat working directory');
  });
});

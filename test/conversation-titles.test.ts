import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationTitles, temporaryTitle } from '../server/conversation-titles.js';
import { parseGeneratedTitle } from '../server/title-generator.js';
import { AccountRegistry, type AccountRouteContext } from '../src/accounts.js';
import { ProjectRegistry, type Conversation } from '../server/projects.js';
import { SessionManager } from '../server/manager.js';
import type { TitleGenerator } from '../server/title-generator.js';
import type { ProviderId } from '../src/provider.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
  vi.restoreAllMocks();
});
function fixture(generate: TitleGenerator = async () => 'Conversation layout improvements') {
  const root = mkdtempSync(join(tmpdir(), 'x056-title-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'projects.json'),
    projects = () => ProjectRegistry.load(file),
    reg = projects(),
    p = reg.create('Panel', root);
  const registry = AccountRegistry.init(join(root, 'accounts.json'), [
    { name: 'a', configDir: join(root, 'a') },
    { name: 'b', configDir: join(root, 'b') },
    { name: 'g', configDir: join(root, 'g'), provider: 'codex' },
  ]);
  for (const name of ['a', 'b', 'g']) registry.markOk(name);
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const state = {
    loads: {} as Record<string, number>,
    priority: false,
    route: {} as AccountRouteContext,
  };
  const call = vi.fn(generate),
    changed = vi.fn();
  const options = {
    projects,
    accounts: () => registry,
    loads: () => state.loads,
    priorityWork: () => state.priority,
    routing: () => state.route,
    changed,
    generate: call,
    history: () => [
      { role: 'user' as const, text: 'Improve conversation layout and spacing.' },
      { role: 'assistant' as const, text: 'I simplified the navigation and composer.' },
    ],
  };
  const worker = new ConversationTitles(root, options);
  cleanup.push(() => worker.close());
  const add = (sid: string, origin?: Conversation['titleOrigin'], provider: ProviderId = 'claude') => {
    const r = projects();
    r.addConversation(p.id, sid, 'Original ' + sid, provider, origin);
    return { projectId: p.id, sessionId: sid };
  };
  return {
    root,
    file,
    projects,
    registry,
    worker,
    options,
    call,
    state,
    changed,
    add,
    p,
    advance: (ms = 2000) => {
      now += ms;
    },
  };
}
describe('conversation naming', () => {
  it('cleans greetings and Markdown while preserving multilingual prompt titles', () => {
    expect(temporaryTitle('Hi Astra, improve the panel\nmore context')).toBe('improve the panel');
    expect(temporaryTitle('Can you please improve recent conversations?')).toBe(
      'improve recent conversations',
    );
    expect(temporaryTitle('I want:\n- Better account routing')).toBe('Better account routing');
    expect(temporaryTitle('Hi Astra\n- Perbaiki navigasi percakapan')).toBe(
      'Perbaiki navigasi percakapan',
    );
    expect(
      temporaryTitle('[The user attached an image]\n\n〈x056 question protocol〉\nKeep working'),
    ).toBe('New conversation');
    expect(parseGeneratedTitle('{"title":"Perbaikan navigasi percakapan"}')).toBe(
      'Perbaikan navigasi percakapan',
    );
    expect(parseGeneratedTitle('{"title":null}')).toBeNull();
    for (const raw of [
      'Just a title',
      '{"title":"Continue"}',
      '{"title":"a\\nb"}',
      '{"title":"<script>"}',
    ])
      expect(() => parseGeneratedTitle(raw)).toThrow();
  });
  it('automatically names a new chat once, while preserving old and manually named chats', async () => {
    const f = fixture(),
      fresh = f.add('fresh', 'temporary');
    f.add('old');
    f.add('manual', 'manual');
    for (const sid of ['fresh', 'old', 'manual'])
      f.worker.observe(f.p.id, sid, 'Improve conversation navigation', 'The navigation is ready.');
    expect(f.worker.list()).toHaveLength(1);
    f.advance();
    await f.worker.tick();
    expect(
      f
        .projects()
        .conversations(f.p.id)
        .find((c) => c.sessionId === 'fresh'),
    ).toMatchObject({
      title: 'Conversation layout improvements',
      titleOrigin: 'generated',
      titleRevision: 2,
    });
    expect(
      f
        .projects()
        .conversations(f.p.id)
        .find((c) => c.sessionId === 'old')?.title,
    ).toBe('Original old');
    f.worker.observe(fresh.projectId, fresh.sessionId, 'Now fix a different area', 'Done');
    f.advance();
    await f.worker.tick();
    expect(f.call).toHaveBeenCalledTimes(1);
  });
  it('waits for a meaningful exchange and honors disabling automatic naming', () => {
    const f = fixture(),
      t = f.add('chat', 'temporary');
    for (const prompt of ['Continue', 'Build it', 'Yes', 'What’s next?'])
      f.worker.observe(t.projectId, t.sessionId, prompt, 'Ready.');
    expect(f.worker.list()).toHaveLength(0);
    f.worker.configure({ enabled: false });
    f.worker.observe(t.projectId, t.sessionId, 'Fix keyboard navigation', 'Done');
    expect(f.worker.list()).toHaveLength(0);
    f.worker.configure({ enabled: true });
    f.worker.observe(t.projectId, t.sessionId, 'Fix keyboard navigation', 'Done');
    expect(f.worker.list()[0].status).toBe('waiting');
    f.worker.configure({ enabled: false });
    expect(f.worker.list()[0].status).toBe('skipped');
  });
  it('does not overwrite a manual rename when an automatic result arrives late', async () => {
    let finish!: (s: string) => void;
    const f = fixture(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
      t = f.add('chat', 'temporary');
    f.worker.observe(t.projectId, t.sessionId, 'Fix keyboard navigation', 'Done');
    f.advance();
    const running = f.worker.tick();
    expect(f.worker.activeAccount).toBe('a');
    f.projects().renameConversation(t.projectId, t.sessionId, 'My chosen title');
    finish('Generated keyboard title');
    await running;
    expect(f.worker.list()[0].status).toBe('stale');
    expect(f.projects().conversations(t.projectId)[0]).toMatchObject({
      title: 'My chosen title',
      titleOrigin: 'manual',
    });
  });
  it('previews bulk names, applies explicitly and supports conflict-safe Undo', async () => {
    const f = fixture(),
      a = f.add('a'),
      b = f.add('b', 'manual'),
      jobs = f.worker.suggest([a, b]);
    f.advance();
    await f.worker.tick();
    await f.worker.tick();
    expect(
      f
        .projects()
        .conversations(f.p.id)
        .map((c) => c.title),
    ).toEqual(['Original a', 'Original b']);
    expect(f.worker.list().every((j) => j.status === 'ready')).toBe(true);
    const ids = jobs.map((j) => j.id);
    expect(f.worker.apply(ids).applied).toEqual(ids);
    expect(f.worker.apply(ids).applied).toEqual(ids); // retry never writes twice
    f.projects().renameConversation(b.projectId, b.sessionId, 'A later manual edit');
    const undo = f.worker.undo(ids);
    expect(undo.undone).toEqual([ids[0]]);
    expect(undo.skipped).toHaveLength(1);
    expect(
      f
        .projects()
        .conversations(f.p.id)
        .map((c) => c.title),
    ).toEqual(['Original a', 'A later manual edit']);
    expect(f.projects().conversations(f.p.id)[0].titleOrigin).toBeUndefined();
  });
  it('rejects a stale preview even if the title text was changed and changed back', async () => {
    const f = fixture(),
      t = f.add('chat'),
      [job] = f.worker.suggest([t]);
    f.advance();
    await f.worker.tick();
    f.projects().renameConversation(t.projectId, t.sessionId, 'Changed');
    f.projects().renameConversation(t.projectId, t.sessionId, job.before);
    expect(f.worker.apply([job.id]).skipped).toHaveLength(1);
    expect(f.worker.list()[0].status).toBe('stale');
  });
  it('respects account priorities, active load, locks, exhausted quota and reserves', async () => {
    const f = fixture(),
      t = f.add('chat', 'temporary');
    f.registry.setRouting('claude', 'priority', ['b', 'a']);
    f.state.loads = { b: 1 };
    f.registry.setCapacity('a', 1, 20);
    writeFileSync(
      join(f.root, 'quota-cache.json'),
      JSON.stringify({
        a: {
          at: Date.now(),
          quota: {
            fiveHour: { utilization: 85, resetsAt: new Date(Date.now() + 3600000).toISOString() },
          },
        },
      }),
    );
    f.worker.observe(t.projectId, t.sessionId, 'Fix keyboard navigation', 'Done');
    f.advance();
    await f.worker.tick();
    expect(f.call).not.toHaveBeenCalled();
    f.state.route = { lockedAccount: 'b', useReserve: true };
    await f.worker.tick();
    expect(f.call).not.toHaveBeenCalled();
    f.state.loads = {};
    f.state.priority = true;
    await f.worker.tick();
    expect(f.call).not.toHaveBeenCalled();
    f.state.priority = false;
    await f.worker.tick();
    expect(f.call.mock.calls[0][0].account.name).toBe('b');
  });
  it('round-robins naming jobs without consuming the account selected for the next chat', async () => {
    const f = fixture();
    f.registry.setRouting('claude', 'round-robin', ['a', 'b']);
    const original = f.registry.activeName('claude');
    const first = f.add('first'),
      second = f.add('second');
    f.worker.suggest([first, second]);
    f.advance();
    await f.worker.tick();
    await f.worker.tick();
    expect(f.call.mock.calls.map(([input]) => input.account.name)).toEqual(['a', 'b']);
    expect(f.registry.activeName('claude')).toBe(original);
  });
  it('routes Codex naming to a Codex account and stores a provider-specific model setting', async () => {
    const f = fixture(),
      t = f.add('codex', 'temporary', 'codex');
    f.worker.configure({ models: { codex: 'gpt-fixture' } });
    f.worker.observe(t.projectId, t.sessionId, 'Fix the keyboard controls', 'Done');
    f.advance();
    await f.worker.tick();
    expect(f.call.mock.calls[0][0]).toMatchObject({
      provider: 'codex',
      model: 'gpt-fixture',
      account: { name: 'g' },
    });
    expect(() => f.worker.configure({ models: { claude: 'gpt-fixture' } })).toThrow('another provider');
    const reopened = new ConversationTitles(f.root, f.options);
    expect(reopened.settings().models.codex).toBe('gpt-fixture');
  });
  it('releases its account and retries later when foreground work interrupts naming', async () => {
    let finish!: (s: string) => void;
    const f = fixture(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
      t = f.add('chat', 'temporary');
    f.worker.observe(t.projectId, t.sessionId, 'Fix keyboard navigation', 'Done');
    f.advance();
    const running = f.worker.tick();
    f.worker.preempt();
    expect(f.worker.activeAccount).toBeUndefined();
    finish('Late keyboard title');
    await running;
    expect(f.worker.list()[0]).toMatchObject({ status: 'waiting', attempts: 0 });
    f.call.mockResolvedValue('Keyboard navigation improvements');
    f.advance(11000);
    await f.worker.tick();
    expect(f.worker.list()[0].status).toBe('applied');
  });
  it('recovers interrupted jobs after restart and bounds failed generation attempts', async () => {
    const f = fixture(async () => {
        throw new Error('Provider unavailable');
      }),
      t = f.add('chat');
    f.worker.suggest([t]);
    const state = JSON.parse(readFileSync(join(f.root, 'conversation-titles.json'), 'utf8'));
    state.jobs[0].status = 'generating';
    writeFileSync(join(f.root, 'conversation-titles.json'), JSON.stringify(state));
    const reopened = new ConversationTitles(f.root, f.options);
    expect(reopened.list()[0].status).toBe('waiting');
    for (let i = 0; i < 3; i++) {
      f.advance(100000);
      await reopened.tick();
    }
    expect(reopened.list()[0]).toMatchObject({ status: 'failed', attempts: 3 });
    f.advance(100000);
    await reopened.tick();
    expect(f.call).toHaveBeenCalledTimes(3);
  });
  it('keeps manual titles locked, deduplicates pending requests and persists dismissals', async () => {
    const f = fixture(),
      t = f.add('chat', 'manual');
    const [job] = f.worker.suggest([t]);
    expect(f.worker.suggest([t])[0].id).toBe(job.id);
    f.worker.dismiss([job.id]);
    f.advance();
    await f.worker.tick();
    expect(f.call).not.toHaveBeenCalled();
    expect(new ConversationTitles(f.root, f.options).list()[0].status).toBe('skipped');
    expect(() => f.worker.suggest(Array(51).fill(t))).toThrow('50');
    expect(() => f.worker.apply(['missing'])).toThrow('not found');
  });
  it('queues naming after a real manager completion without putting memory or ASK instructions into its source', async () => {
    const f = fixture();
    const manager = new SessionManager({
      stateDir: f.root,
      workspaceRoot: f.root,
      titleGenerator: f.call,
      runSessionFn: async () => ({
        status: 'completed',
        failovers: 0,
        resultText: 'Keyboard support is ready.',
      }),
    });
    const sid = manager.start(
      'Hi Astra, fix keyboard navigation\n\n〈x056 question protocol〉\nKeep working.',
      undefined,
      undefined,
      f.p.id,
    );
    expect(manager.listConversations(f.p.id).find((c) => c.sessionId === sid)).toMatchObject({
      title: 'fix keyboard navigation',
      titleOrigin: 'temporary',
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(manager.listConversations(f.p.id).find((c) => c.sessionId === sid)?.titleOrigin).toBe(
      'temporary',
    );
    f.advance();
    await manager.titles().tick();
    expect(f.call.mock.calls[0][0].prompt).not.toContain('question protocol');
    expect(manager.listConversations(f.p.id).find((c) => c.sessionId === sid)?.titleOrigin).toBe(
      'generated',
    );
    manager.titles().close();
    manager.memory().close();
  });
});

import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, unlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ArtifactStore, DeliveryStore, writeState } from '../server/workspace-store.js';
import { SessionManager } from '../server/manager.js';
import { ProjectRegistry } from '../server/projects.js';
const dir = () => mkdtempSync(join(tmpdir(), 'x056-workspace-test-'));
describe('persistent artifacts', () => {
  it('copies screenshots and deduplicates an unchanged output, surviving source deletion and restart', () => {
    const root = dir(),
      path = join(root, 'screen.png');
    writeFileSync(path, 'image bytes');
    const store = new ArtifactStore(root, () => [root]);
    const input = {
      projectId: 'p',
      sessionId: 's',
      title: 'Screenshot',
      kind: 'image' as const,
      path,
      source: 'response' as const,
    };
    const first = store.add(input);
    expect(store.add(input).id).toBe(first.id);
    unlinkSync(path);
    const restored = new ArtifactStore(root, () => [root]);
    expect(readFileSync(restored.fileFor(first.id)!.path, 'utf8')).toBe('image bytes');
  });
  it('rejects secrets, unsupported files, and escaping symlinks', () => {
    const root = dir(),
      store = new ArtifactStore(root, () => [root]);
    const input = {
      projectId: 'p',
      sessionId: 's',
      title: 'File',
      kind: 'file' as const,
      source: 'manual' as const,
    };
    for (const name of ['.env', 'token.json', 'script.sh']) {
      const path = join(root, name);
      writeFileSync(path, 'secret');
      expect(() => store.add({ ...input, path })).toThrow();
    }
    const link = join(root, 'passwd.txt');
    symlinkSync('/etc/passwd', link);
    expect(() => store.add({ ...input, path: link })).toThrow();
  });
  it('collects multiple links and labels reported test summaries', () => {
    const root = dir(),
      store = new ArtifactStore(root, () => [root]),
      path = join(root, 'result.png');
    writeFileSync(path, 'image');
    store.collect(
      'p',
      's',
      `[Screenshot](${path}) and [Preview](https://preview.example.test).\nTests: 24 passed, 0 failed`,
    );
    expect(store.list()).toHaveLength(3);
    expect(store.list().find((x) => x.kind === 'test')).toMatchObject({
      status: 'passed',
      source: 'response',
    });
    expect(() =>
      store.add({
        projectId: 'p',
        sessionId: 's',
        title: 'Bad',
        kind: 'preview',
        source: 'manual',
        url: 'javascript:alert(1)',
      }),
    ).toThrow();
  });
});
it('keeps removed outputs dismissed on rescans, while allowing manual restoration', () => {
  const root = dir(),
    store = new ArtifactStore(root, () => [root]);
  const response = '[Preview](https://preview.example.test)\nTests: 12 passed';
  store.collect('p', 's', response);
  store.list().forEach((x) => store.remove(x.id));
  new ArtifactStore(root, () => [root]).collect('p', 's', response);
  expect(store.list()).toEqual([]);
  store.add({
    projectId: 'p',
    sessionId: 's',
    title: 'Preview',
    kind: 'preview',
    url: 'https://preview.example.test',
    source: 'manual',
  });
  expect(store.list()).toHaveLength(1);
});
describe('message receipts', () => {
  it('does not repeat an accepted message after a lost response or restart', () => {
    const root = dir(),
      store = new DeliveryStore(root),
      body = { requestId: 'request-1234567890', prompt: 'Hello' },
      send = vi.fn(() => ({ sessionId: 's' }));
    const first = store.run(body, send);
    expect(first.status).toBe('accepted');
    expect(new DeliveryStore(root).run(body, send)).toEqual(first);
    expect(send).toHaveBeenCalledTimes(1);
    expect(() => store.run({ ...body, prompt: 'Different' }, send)).toThrow();
  });
  it('allows retry after a rejected message and marks interrupted processing uncertain', () => {
    const root = dir(),
      store = new DeliveryStore(root),
      body = { requestId: 'request-1234567890' };
    expect(() =>
      store.run(body, () => {
        throw new Error('No available account');
      }),
    ).toThrow();
    expect(store.get(body.requestId)?.status).toBe('failed');
    expect(store.run(body, () => ({ sessionId: 's' })).status).toBe('accepted');
    const rows = store.all();
    rows[body.requestId].status = 'processing';
    writeState(join(root, 'message-receipts.json'), rows);
    const reopened = new DeliveryStore(root),
      send = vi.fn();
    expect(reopened.run(body, send).status).toBe('uncertain');
    expect(send).not.toHaveBeenCalled();
  });
});
describe('queue planner', () => {
  afterEach(() => vi.useRealTimers());
  function fixture() {
    const root = dir(),
      state = join(root, 'state');
    mkdirSync(state);
    const reg = ProjectRegistry.load(join(state, 'projects.json')),
      p = reg.create('Test', root);
    reg.addConversation(p.id, 's', 'Main', 'claude');
    reg.addConversation(p.id, 'other', 'Dependency', 'claude');
    const manager = new SessionManager({ stateDir: state, workspaceRoot: root });
    return { manager, p, state, root };
  }
  it('persists scheduled heads, reorders paused messages, and dispatches only when eligible', async () => {
    vi.useFakeTimers();
    const { manager, p, state, root } = fixture();
    const send = vi.spyOn(manager, 'continueSession').mockReturnValue('s');
    const first = manager.enqueue(p.id, { text: 'First', sessionId: 's', notBefore: Date.now() + 5000 });
    const second = manager.enqueue(p.id, { text: 'Second', sessionId: 's', paused: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).not.toHaveBeenCalled();
    manager.reorderQueue(p.id, [second.id, first.id]);
    manager.tickQueuePlanner();
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).not.toHaveBeenCalled();
    manager.editQueueItem(p.id, second.id, { paused: false });
    manager.tickQueuePlanner();
    await vi.advanceTimersByTimeAsync(401);
    expect(send).toHaveBeenCalledWith(p.id, 's', 'Second', expect.anything());
    expect(
      new SessionManager({ stateDir: state, workspaceRoot: root }).queues()[p.id].map((x) => x.id),
    ).toEqual([first.id]);
  });
  it('honors a dependency and cancellation during the dispatch delay', async () => {
    vi.useFakeTimers();
    const { manager, p } = fixture(),
      send = vi.spyOn(manager, 'continueSession').mockReturnValue('s');
    const busy = vi
      .spyOn(manager as unknown as { sessionBusy(s: string): boolean }, 'sessionBusy')
      .mockImplementation((s) => s === 'other');
    const item = manager.enqueue(p.id, { text: 'Dependent', sessionId: 's', afterSessionId: 'other' });
    manager.tickQueuePlanner();
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).not.toHaveBeenCalled();
    busy.mockReturnValue(false);
    manager.tickQueuePlanner();
    manager.removeQueueItem(p.id, item.id);
    await vi.advanceTimersByTimeAsync(500);
    expect(send).not.toHaveBeenCalled();
    expect(manager.queues()[p.id]).toHaveLength(0);
  });
  it('pauses a rejected dispatch until the operator resumes it', async () => {
    vi.useFakeTimers();
    const { manager, p } = fixture();
    const send = vi
      .spyOn(manager, 'continueSession')
      .mockImplementationOnce(() => {
        throw new Error('Account unavailable');
      })
      .mockReturnValue('s');
    const item = manager.enqueue(p.id, { text: 'Try later', sessionId: 's' });
    await vi.advanceTimersByTimeAsync(401);
    expect(manager.queues()[p.id][0]).toMatchObject({ paused: true, error: 'Account unavailable' });
    manager.tickQueuePlanner();
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(1);
    manager.editQueueItem(p.id, item.id, { paused: false });
    manager.tickQueuePlanner();
    await vi.advanceTimersByTimeAsync(401);
    expect(send).toHaveBeenCalledTimes(2);
    expect(manager.queues()[p.id]).toEqual([]);
  });
  it('does not repeat a launched message when removing its queue entry fails', async () => {
    vi.useFakeTimers();
    const { manager, p, state, root } = fixture();
    const send = vi.spyOn(manager, 'continueSession').mockReturnValue('s');
    manager.enqueue(p.id, { text: 'Send once', sessionId: 's' });
    const internal = manager as unknown as { saveQueues(value: unknown): void };
    const original = internal.saveQueues.bind(internal);
    let writes = 0;
    vi.spyOn(internal, 'saveQueues').mockImplementation((value) => {
      if (++writes === 2) throw new Error('Disk full');
      original(value);
    });
    await vi.advanceTimersByTimeAsync(401);
    expect(send).toHaveBeenCalledTimes(1);
    expect(manager.queues()[p.id][0].dispatching).toBe(true);
    const reopened = new SessionManager({ stateDir: state, workspaceRoot: root }),
      retry = vi.spyOn(reopened, 'continueSession');
    reopened.tickQueuePlanner();
    await vi.advanceTimersByTimeAsync(5000);
    expect(retry).not.toHaveBeenCalled();
  });
});

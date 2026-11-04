// The image-reference path runs on EVERY tool completion (subagents
// included). A path that can never be added used to be retried on each one
// until the turn ended, each retry re-reading both project registries; a
// known image was re-read and re-hashed on every mention. These tests count
// the work, not only the result.
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const reads = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    reads.paths.push(String(args[0]));
    return fs.readFileSync(...args);
  }) as typeof fs.readFileSync;
  return { ...fs, default: { ...fs, readFileSync }, readFileSync };
});

import { ArtifactRejectedError, ArtifactStore } from '../server/workspace-store.js';
import { IMAGE_RETRY, WorkspaceController } from '../server/workspace.controller.js';
import { gatewayDb, putArtifact } from '../server/gateway-db.js';
import type { GatewayEvent, SessionManager } from '../server/manager.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
  vi.restoreAllMocks();
  vi.useRealTimers();
  reads.paths.length = 0;
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'x056-artifact-cost-')),
    state = join(root, 'state');
  mkdirSync(state);
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  let listener: (e: GatewayEvent) => void = () => {};
  const listProjects = vi.fn(() => ({ projects: [{ id: 'p', cwd: root }] }));
  const manager = {
    subscribe: (fn: (e: GatewayEvent) => void) => {
      listener = fn;
      return () => {};
    },
    listProjects,
    tickQueuePlanner() {},
  };
  const add = vi.spyOn(ArtifactStore.prototype, 'add');
  const controller = new WorkspaceController(manager as unknown as SessionManager, state);
  cleanup.push(() => controller.onModuleDestroy());
  let seq = 0;
  const emit = (kind: string, data: Record<string, unknown> = {}) =>
    listener({ seq: ++seq, ts: new Date().toISOString(), kind, data: { projectId: 'p', sessionId: 's', ...data } });
  const reference = (path: string) => emit('artifact_reference', { paths: [path] });
  const toolDone = () => emit('activity', { status: 'done' });
  const library = () => controller.list('p', 's');
  const readsOf = (path: string) => reads.paths.filter((x) => x === path).length;
  return { root, state, controller, emit, reference, toolDone, library, add, listProjects, readsOf };
}

describe('permanently rejected image references', () => {
  it.each([
    ['a hidden folder', (root: string) => (mkdirSync(join(root, '.hidden')), join(root, '.hidden', 'shot.png'))],
    ['a credential-like name', (root: string) => join(root, 'secret-shot.png')],
    ['an unsupported type', (root: string) => join(root, 'shot.sh')],
  ])('in %s is tried once, not on every later tool completion', (_name, place) => {
    const f = setup();
    const path = place(f.root);
    writeFileSync(path, 'bytes');
    f.reference(path);
    for (let i = 0; i < 50; i++) f.toolDone();
    expect(f.add).toHaveBeenCalledTimes(1);
    expect(f.listProjects.mock.calls.length).toBeLessThanOrEqual(2);
    f.emit('session_done');
    expect(f.add).toHaveBeenCalledTimes(1);
    expect(f.library()).toEqual([]);
  });
  it('is not tried again when named again within the rejection memo, even across turns', () => {
    const f = setup();
    mkdirSync(join(f.root, '.hidden'));
    const path = join(f.root, '.hidden', 'shot.png');
    writeFileSync(path, 'bytes');
    f.reference(path);
    f.toolDone();
    for (let i = 0; i < 20; i++) {
      f.reference(path);
      f.toolDone();
    }
    f.emit('session_done');
    f.reference(path);
    f.toolDone();
    expect(f.add).toHaveBeenCalledTimes(1);
  });
  it('throws a distinguishable error class for rejections, and the fs error for a missing file', () => {
    const f = setup();
    const store = new ArtifactStore(f.state, () => [f.root]);
    const input = { projectId: 'p', sessionId: 's', title: 'x', kind: 'image' as const, source: 'response' as const };
    writeFileSync(join(f.root, 'token.png'), 'x');
    let error: unknown;
    try { store.add({ ...input, path: join(f.root, 'token.png') }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(ArtifactRejectedError);
    expect(error).toMatchObject({ code: 'rejected', message: 'This file cannot be added to the library.' });
    try { store.add({ ...input, path: join(f.root, 'gone.png') }); } catch (e) { error = e; }
    expect(error).toMatchObject({ code: 'ENOENT' });
  });
  it('reads the project registries once per add, not twice', () => {
    const f = setup();
    mkdirSync(join(f.root, '.hidden'));
    const path = join(f.root, '.hidden', 'shot.png');
    writeFileSync(path, 'bytes');
    const roots = vi.fn(() => [f.root]);
    const store = new ArtifactStore(f.state, roots);
    expect(() =>
      store.add({ projectId: 'p', sessionId: 's', title: 'x', kind: 'image', source: 'response', path }),
    ).toThrow('cannot be added');
    expect(roots).toHaveBeenCalledTimes(1);
  });
});

describe('image references whose file does not exist yet', () => {
  it('a burst of tool completions makes one attempt, not one per event', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = setup();
    f.reference(join(f.root, 'later.png'));
    for (let i = 0; i < 50; i++) f.toolDone();
    expect(f.add).toHaveBeenCalledTimes(1);
  });
  it(`is retried at most ${IMAGE_RETRY.attempts} times, then dropped`, () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = setup();
    const path = join(f.root, 'never.png');
    f.reference(path);
    for (let i = 0; i < 200; i++) {
      f.toolDone();
      vi.advanceTimersByTime(1_000);
    }
    expect(f.add).toHaveBeenCalledTimes(IMAGE_RETRY.attempts);
    // Dropped: it appearing now, and the turn ending, cost nothing more.
    writeFileSync(path, 'too late');
    for (let i = 0; i < 20; i++) f.toolDone();
    f.emit('session_done');
    expect(f.add).toHaveBeenCalledTimes(IMAGE_RETRY.attempts);
    expect(f.library()).toEqual([]);
  });
  it('is dropped once the retry window has passed', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = setup();
    f.reference(join(f.root, 'never.png'));
    f.toolDone();
    vi.advanceTimersByTime(IMAGE_RETRY.windowMs + 1);
    f.toolDone();
    expect(f.add).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_000);
    f.toolDone();
    f.emit('session_done');
    expect(f.add).toHaveBeenCalledTimes(2);
  });
  it('is added once when it appears, and not retried after', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = setup();
    const path = join(f.root, 'shot.png');
    f.reference(path);
    f.toolDone();
    expect(f.add).toHaveBeenCalledTimes(1);
    writeFileSync(path, 'screenshot');
    vi.advanceTimersByTime(1_000);
    f.toolDone();
    expect(f.add).toHaveBeenCalledTimes(2);
    expect(f.library()).toHaveLength(1);
    for (let i = 0; i < 20; i++) {
      f.toolDone();
      vi.advanceTimersByTime(1_000);
    }
    f.emit('session_done');
    expect(f.add).toHaveBeenCalledTimes(2);
    expect(f.library()).toHaveLength(1);
  });
  it('gets a final attempt when the turn ends, regardless of the retry gap', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = setup();
    const path = join(f.root, 'shot.png');
    f.reference(path);
    f.toolDone();
    writeFileSync(path, 'screenshot');
    f.emit('session_done');
    expect(f.library()).toHaveLength(1);
  });
});

describe('re-mentioned images', () => {
  it('are not read or hashed again while unchanged', () => {
    const f = setup();
    const path = join(f.root, 'shot.png');
    writeFileSync(path, 'screenshot one');
    f.reference(path);
    f.toolDone();
    expect(f.library()).toHaveLength(1);
    expect(f.readsOf(path)).toBe(1);
    for (let i = 0; i < 10; i++) {
      f.reference(path);
      f.toolDone();
    }
    expect(f.add).toHaveBeenCalledTimes(11);
    expect(f.readsOf(path)).toBe(1);
    expect(f.library()).toHaveLength(1);
  });
  it('are copied again when the same path is overwritten (same size, new mtime)', () => {
    const f = setup();
    const path = join(f.root, 'shot.png');
    writeFileSync(path, 'screenshot AAA');
    f.reference(path);
    f.toolDone();
    writeFileSync(path, 'screenshot BBB');
    const t = statSync(path).mtimeMs / 1000 + 5;
    utimesSync(path, t, t);
    f.reference(path);
    f.toolDone();
    expect(f.readsOf(path)).toBe(2);
    expect(f.library()).toHaveLength(2);
    writeFileSync(path, 'a different, longer screenshot');
    f.reference(path);
    f.toolDone();
    expect(f.library()).toHaveLength(3);
  });
  it('rows from before mtimeMs was stored are hashed once, then take the fast path', () => {
    const f = setup();
    const path = join(f.root, 'old.png');
    writeFileSync(path, 'old screenshot');
    const store = new ArtifactStore(f.state, () => [f.root]);
    const input = { projectId: 'p', sessionId: 's', title: 'old.png', kind: 'image' as const, source: 'response' as const, path };
    const first = store.add(input);
    const legacy: Record<string, unknown> = { ...first };
    delete legacy.mtimeMs;
    putArtifact(gatewayDb(f.state), legacy);
    reads.paths.length = 0;
    expect(store.add(input).id).toBe(first.id);
    expect(f.readsOf(path)).toBe(1);
    expect(store.add(input).id).toBe(first.id);
    expect(f.readsOf(path)).toBe(1);
  });
});

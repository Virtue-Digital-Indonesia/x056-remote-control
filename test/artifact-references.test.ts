import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { imagePaths, toolImagePaths } from '../src/artifact-references.js';
import { ArtifactStore } from '../server/workspace-store.js';
import { WorkspaceController } from '../server/workspace.controller.js';
import { SessionManager } from '../server/manager.js';
import { ProjectRegistry } from '../server/projects.js';
import { codexAdapter } from '../src/adapters/codex.js';
import { claudeAdapter } from '../src/adapters/claude.js';
import type { ProviderAdapter } from '../src/provider.js';
import type { RawEvent } from '../src/types.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function directory(parent = tmpdir()) {
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'x056-artifacts-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const input = {
  projectId: 'p',
  sessionId: 's',
  title: 'Screenshot',
  kind: 'image' as const,
  source: 'response' as const,
};

describe('local image references', () => {
  it('extracts local Markdown, sandbox, quoted and command references without treating remote URLs as files', () => {
    const text =
      '[Draft](sandbox:/tmp/draft.png) [Mobile](</tmp/small screen.webp>)\n' +
      'node shot.cjs https://example.test /tmp/page.png\n' +
      'https://example.test/remote.png //server/share.png';
    expect(imagePaths(text).sort()).toEqual([
      '/tmp/draft.png',
      '/tmp/page.png',
      '/tmp/small screen.webp',
    ]);
  });
  it('handles JSON arguments, code tool inputs, arrays and both provider event envelopes', () => {
    expect(
      toolImagePaths({
        type: 'item.completed',
        item: {
          type: 'mcp_tool_call',
          arguments: { path: '/tmp/mcp.png' },
          result: '/tmp/not-an-input.png',
        },
      }),
    ).toEqual(['/tmp/mcp.png']);
    expect(
      toolImagePaths({
        type: 'response_item',
        payload: {
          type: 'function_call',
          arguments: JSON.stringify({ path: '/tmp/my image.png' }),
        },
      }),
    ).toEqual(['/tmp/my image.png']);
    expect(
      toolImagePaths({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              input: { command: 'node shot.cjs url "/tmp/with spaces.png"' },
            },
          ],
        },
      }),
    ).toEqual(['/tmp/with spaces.png']);
    expect(
      toolImagePaths({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: ['node', 'shot', '/tmp/screen.png'],
        },
      }),
    ).toEqual(['/tmp/screen.png']);
    expect(
      toolImagePaths({
        type: 'custom_tool_call',
        input: 'image(await tools.view_image({path:"/tmp/preview.png"}));',
      }),
    ).toEqual(['/tmp/preview.png']);
  });
  it('does not collect reasoning, user text or arbitrary tool outputs', () => {
    for (const type of ['reasoning', 'thinking', 'function_call_output', 'tool_result', 'user_message'])
      expect(
        toolImagePaths({
          type,
          input: '/tmp/private.png',
          output: '/tmp/private.png',
          message: '/tmp/private.png',
        }),
      ).toEqual([]);
  });
});

describe('artifact retention and worktrees', () => {
  it('allows registered sibling and hidden-folder worktrees, but rejects neighboring files and escaping links', () => {
    // Outside /tmp: /tmp is already an approved artifact root and would mask this regression.
    const base = directory(resolve('.deploy'));
    const root = join(base, 'project'),
      other = join(base, 'other'),
      sibling = join(base, 'project-preview');
    mkdirSync(root);
    mkdirSync(other);
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
    git('init');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    );
    git('worktree', 'add', '-b', 'preview', sibling);
    const nested = join(root, '.claude', 'worktrees', 'layout');
    git('worktree', 'add', '-b', 'layout', nested);
    const store = new ArtifactStore(join(base, 'state'), () => [other, root]);
    for (const [i, path] of [join(sibling, 'draft.png'), join(nested, 'draft.png')].entries()) {
      writeFileSync(path, 'image' + i);
      expect(store.add({ ...input, path }).original).toBe(path);
    }
    const outside = join(base, 'unregistered.png');
    writeFileSync(outside, 'private');
    expect(() => store.add({ ...input, path: outside })).toThrow('cannot be added');
    const hidden = join(nested, '.hidden');
    mkdirSync(hidden);
    writeFileSync(join(hidden, 'secret.png'), 'private');
    expect(() => store.add({ ...input, path: join(hidden, 'secret.png') })).toThrow('cannot be added');
    symlinkSync(outside, join(sibling, 'escape.png'));
    expect(() => store.add({ ...input, path: join(sibling, 'escape.png') })).toThrow('cannot be added');
  });
  it('deduplicates copied images by content and keeps dismissed images dismissed on scans', () => {
    const root = directory(),
      store = new ArtifactStore(root, () => [root]);
    const first = join(root, 'first.png'),
      copy = join(root, 'copy.png');
    writeFileSync(first, 'same image');
    writeFileSync(copy, 'same image');
    const item = store.add({ ...input, path: first });
    expect(store.add({ ...input, path: copy }).id).toBe(item.id);
    store.remove(item.id);
    store.collect('p', 's', `[Copy](${copy})`);
    expect(store.list()).toEqual([]);
    store.add({ ...input, path: copy, source: 'manual' });
    expect(store.list()).toHaveLength(1);
    unlinkSync(first);
    unlinkSync(copy);
    expect(store.collect('p', 's', `[Original](${first})`).skipped).toEqual([]);
    expect(readFileSync(store.fileFor(item.id)!.path, 'utf8')).toBe('same image');
  });
  it('resolves project-relative links and returns explicit missing-image warnings', () => {
    const root = directory(),
      store = new ArtifactStore(root, () => [root]);
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'draft.png'), 'image');
    const report = store.collect(
      'p',
      's',
      `[Draft](docs/draft.png) [Missing](sandbox:${root}/gone.png)`,
      root,
    );
    expect(store.list()[0].title).toBe('Draft');
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].target).toBe(join(root, 'gone.png'));
    expect(report.skipped[0].reason).toBe('The original file is no longer available.');
  });
});

describe('provider image history and collection', () => {
  function history(provider: 'claude' | 'codex', lines: unknown[]) {
    const dir = directory(),
      sid = 'image-history';
    const folder =
      provider === 'codex'
        ? join(dir, 'sessions', '2026', '09', '08')
        : join(dir, 'projects', 'fixture');
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, provider === 'codex' ? `rollout-2026-09-08T00-00-00-${sid}.jsonl` : sid + '.jsonl'),
      lines.map((x) => JSON.stringify(x)).join('\n') + '\n',
    );
    return { dir, sid };
  }
  it.each(['claude', 'codex'] as const)(
    'keeps image paths independently of shortened %s tool labels',
    (provider) => {
      const command = 'node screenshot.cjs ' + 'x'.repeat(300) + ' "/tmp/long path.png"';
      const lines =
        provider === 'claude'
          ? [
              {
                type: 'assistant',
                message: {
                  role: 'assistant',
                  content: [{ type: 'tool_use', name: 'Bash', input: { command } }],
                },
              },
            ]
          : [
              {
                type: 'response_item',
                payload: {
                  type: 'function_call',
                  name: 'exec_command',
                  arguments: JSON.stringify({ cmd: command }),
                },
              },
            ];
      const { dir, sid } = history(provider, lines);
      const rows = (provider === 'claude' ? claudeAdapter : codexAdapter).readHistory!([dir], sid, 100);
      expect(rows[0]).toMatchObject({
        role: 'action',
        artifacts: ['/tmp/long path.png'],
      });
    },
  );
  function controller(adapter: ProviderAdapter = claudeAdapter) {
    const root = directory(),
      state = join(root, 'state');
    mkdirSync(state);
    const registry = ProjectRegistry.load(join(state, 'projects.json'));
    const project = registry.create('Artifact fixture', root);
    registry.addConversation(project.id, 's', 'Images', adapter.id);
    const manager = new SessionManager({
      stateDir: state,
      workspaceRoot: root,
    });
    manager.historyContext = () => ({
      adapter,
      providerSessionId: 's',
      configDirs: [],
    });
    const controller = new WorkspaceController(manager, state);
    cleanup.push(() => controller.onModuleDestroy());
    return { root, controller, manager, projectId: project.id };
  }
  it('opens local Markdown references through retained artifacts, including review outputs and line suffixes', () => {
    const { root, controller: api, projectId } = controller();
    const review = join(root, '.review-output'), report = join(review, 'result.csv');
    mkdirSync(review);writeFileSync(report, 'id,status\n1,ok\n');
    const item = api.reference({
      projectId,
      sessionId: 's',
      title: 'Exact results',
      target: '.review-output/result.csv:12',
    });
    expect(item).toMatchObject({ title: 'Exact results', original: report, kind: 'file' });
    expect(api.content(item.id)).toMatchObject({ text: expect.stringContaining('1,ok') });
    expect(() => api.reference({ projectId, sessionId: 's', target: 'https://example.test/a.csv' }))
      .toThrow('Only local project file references');
  });
  it('captures a referenced image after the tool completes and serves it after deletion', () => {
    const { root, controller: api, manager, projectId } = controller();
    const path = join(root, 'live.png');
    const internals = manager as unknown as {
      emit(kind: string, data: Record<string, unknown>): void;
      tapToEvents(
        e: RawEvent,
        emit: (kind: string, data: Record<string, unknown>) => void,
        adapter: ProviderAdapter,
      ): void;
    };
    const emit = (kind: string, data: Record<string, unknown>) =>
      internals.emit(kind, { ...data, projectId, sessionId: 's' });
    internals.tapToEvents(
      {
        type: 'item.started',
        item: {
          type: 'command_execution',
          id: 'tool1',
          command: 'node shot ' + path,
        },
      },
      emit,
      codexAdapter,
    );
    expect(api.list(projectId, 's')).toHaveLength(0);
    writeFileSync(path, 'captured output');
    emit('activity', { status: 'done' });
    unlinkSync(path);
    emit('session_done', {});
    expect(api.list(projectId, 's')).toHaveLength(1);
    expect(api.list(projectId, 's')[0].original).toBe(path);
  });
  it('rescans older history pages and reports missing image references', () => {
    let olderPath = '',
      missingPath = '';
    const cursors: (number | undefined)[] = [];
    const adapter: ProviderAdapter = {
      ...claudeAdapter,
      readHistoryPage: (_dirs, _sid, _limit, before) => {
        cursors.push(before);
        return before === undefined
          ? {
              rows: [{ role: 'assistant', text: 'Latest text only' }],
              cursor: 15,
              done: false,
            }
          : {
              rows: [
                {
                  role: 'action',
                  text: 'Used screenshot tool',
                  artifacts: [olderPath, missingPath],
                },
              ],
              cursor: 0,
              done: true,
            };
      },
    };
    const { root, controller: api, projectId } = controller(adapter);
    olderPath = join(root, 'older.png');
    missingPath = join(root, 'gone.png');
    writeFileSync(olderPath, 'older image');
    const report = api.scanReport({ projectId, sessionId: 's' });
    expect(cursors).toEqual([undefined, 15]);
    expect(report).toMatchObject({
      scanned: 2,
      truncated: false,
      warnings: [{ path: missingPath }],
    });
    expect(report.items.map((x) => x.original)).toEqual([olderPath]);
  });
});

import { appendFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Count real reads of journal files, wherever they come from. The module under
// test imports `readFileSync` by name, so a spy on the namespace would miss it;
// a passthrough mock reaches it.
const journalReads: string[] = [];
const scriptReads: string[] = [];
vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((...args: Parameters<typeof orig.readFileSync>) => {
    const p = String(args[0]);
    if (p.endsWith('journal.jsonl')) journalReads.push(p);
    if (p.endsWith('.js') && p.includes('/workflows/scripts/')) scriptReads.push(p);
    return orig.readFileSync(...args);
  }) as typeof orig.readFileSync;
  return { ...orig, readFileSync, default: { ...orig, readFileSync } };
});

const { liveWorkflowRuns, listWorkflowRuns, sessionsWithWorkflows, workflowRunDir } = await import('../src/adapters/workflows.js');

const SID = '11111111-2222-3333-4444-555555555555';
const SCRIPT = (name: string) => `export const meta = {
  name: '${name}',
  description: 'scan cost fixture',
  phases: [{ title: 'Work', detail: 'fan out' }, { title: 'Verify' }],
}
`;

/**
 * One real `projects/` tree and nine config dirs whose `projects` link to it --
 * the live gateway's layout, where every account shares one transcript tree.
 */
function fleet(): { real: string; configDirs: string[]; runDir: (runId: string) => string } {
  const root = mkdtempSync(join(tmpdir(), 'x056-wfcost-'));
  const real = join(root, 'shared', 'projects');
  const session = join(real, '-proj', SID);
  const runs: [string, unknown[]][] = [
    // finished: two results
    ['wf_done', [
      { type: 'started', key: 'a', agentId: 'a1' }, { type: 'started', key: 'b', agentId: 'b1' },
      { type: 'result', key: 'a', agentId: 'a1', result: 'x'.repeat(2000) },
      { type: 'result', key: 'b', agentId: 'b1', result: 'ok' },
    ]],
    // finished with a failure
    ['wf_failed', [
      { type: 'started', key: 'a', agentId: 'c1' }, { type: 'started', key: 'b', agentId: 'c2' },
      { type: 'result', key: 'a', agentId: 'c1', result: 'ok' },
      { type: 'failed', key: 'b', agentId: 'c2' },
    ]],
    // incomplete and moving: live
    ['wf_live', [
      { type: 'started', key: 'a', agentId: 'd1' }, { type: 'started', key: 'b', agentId: 'd2' },
      { type: 'result', key: 'a', agentId: 'd1', result: 'ok' },
    ]],
  ];
  for (const [runId, journal] of runs) {
    const dir = join(session, 'subagents', 'workflows', runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'journal.jsonl'), journal.map((l) => JSON.stringify(l)).join('\n') + '\n');
    for (const l of journal as { agentId: string; type: string }[]) {
      if (l.type !== 'started') continue;
      writeFileSync(join(dir, `agent-${l.agentId}.jsonl`), JSON.stringify({ type: 'user', message: { role: 'user', content: `do ${l.agentId}` } }) + '\n');
      writeFileSync(join(dir, `agent-${l.agentId}.meta.json`), JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }));
    }
    const scripts = join(session, 'workflows', 'scripts');
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, `job-${runId}.js`), SCRIPT(runId.slice(3)));
  }
  const configDirs: string[] = [];
  for (let i = 0; i < 9; i++) {
    const cd = join(root, `acct-${i}`);
    mkdirSync(cd);
    symlinkSync(real, join(cd, 'projects'));
    configDirs.push(cd);
  }
  return { real, configDirs, runDir: (runId) => join(configDirs[0], 'projects', '-proj', SID, 'subagents', 'workflows', runId) };
}

const strip = (runs: ReturnType<typeof listWorkflowRuns>) => runs.map((r) => ({ ...r, dir: r.dir.slice(r.dir.indexOf('/-proj/')) }));

describe('workflow scans over a shared projects tree', () => {
  let f: ReturnType<typeof fleet>;
  beforeAll(() => { f = fleet(); });

  it('reads each journal once on a cold call, and none on an unchanged second call', () => {
    // Cold cache: these paths have never been read in this process.
    journalReads.length = 0;
    scriptReads.length = 0;
    const live = liveWorkflowRuns(f.configDirs);
    expect(live.map((r) => r.runId)).toEqual(['wf_live']);
    expect(live[0]).toMatchObject({ sessionId: SID, name: 'live', started: 2, finished: 1 });
    expect(journalReads).toHaveLength(3);
    expect(new Set(journalReads).size).toBe(3);
    expect(scriptReads).toHaveLength(3);

    journalReads.length = 0;
    scriptReads.length = 0;
    expect(liveWorkflowRuns(f.configDirs)).toEqual(live);
    expect(journalReads).toHaveLength(0);
    expect(scriptReads).toHaveLength(0);
  });

  it('re-reads a journal that changed, and the result follows it', () => {
    journalReads.length = 0;
    appendFileSync(join(f.runDir('wf_live'), 'journal.jsonl'), JSON.stringify({ type: 'result', key: 'b', agentId: 'd2', result: 'ok' }) + '\n');
    expect(liveWorkflowRuns(f.configDirs)).toEqual([]);
    expect(journalReads).toEqual([join(f.runDir('wf_live'), 'journal.jsonl')]);
    const run = listWorkflowRuns(f.configDirs, SID).find((r) => r.runId === 'wf_live');
    expect(run).toMatchObject({ started: 2, finished: 2, failed: 0, live: false });
  });

  it('gives the same answer as one config dir, under the first config dir\'s path', () => {
    const many = listWorkflowRuns(f.configDirs, SID);
    expect(many.map((r) => r.runId).sort()).toEqual(['wf_done', 'wf_failed', 'wf_live']);
    // Same path the undeduped walk kept: the first config dir's, not the realpath.
    for (const r of many) expect(r.dir.startsWith(join(f.configDirs[0], 'projects'))).toBe(true);
    expect(many.find((r) => r.runId === 'wf_failed')).toMatchObject({ started: 2, finished: 2, failed: 1, name: 'failed', phases: [{ title: 'Work', detail: 'fan out' }, { title: 'Verify' }] });

    const one = listWorkflowRuns([f.configDirs[0]], SID);
    expect(many).toEqual(one);
    // A different single account sees the same runs, only under its own path.
    expect(strip(many)).toEqual(strip(listWorkflowRuns([f.configDirs[4]], SID)));
    expect(sessionsWithWorkflows(f.configDirs)).toEqual([SID]);
    expect(workflowRunDir(f.configDirs, SID, 'wf_done')).toBe(f.runDir('wf_done'));
  });

  it('still walks config dirs whose projects are separate trees', () => {
    const other = mkdtempSync(join(tmpdir(), 'x056-wfcost-other-'));
    const dir = join(other, 'projects', '-p', SID, 'subagents', 'workflows', 'wf_elsewhere');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'journal.jsonl'), JSON.stringify({ type: 'started', key: 'a', agentId: 'z1' }) + '\n');
    const ids = listWorkflowRuns([...f.configDirs, other], SID).map((r) => r.runId).sort();
    expect(ids).toEqual(['wf_done', 'wf_elsewhere', 'wf_failed', 'wf_live']);
  });
});

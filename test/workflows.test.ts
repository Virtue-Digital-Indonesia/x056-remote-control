import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  listWorkflowAgents,
  listWorkflowRuns,
  parseWorkflowMeta,
  readWorkflowAgentPage,
  workflowRunDir,
} from '../src/adapters/workflows.js';

/** Lay out a run exactly as the CLI does, under one or more config dirs. */
function runOnDisk(opts: {
  sessionId: string;
  runId: string;
  script?: string;
  journal?: unknown[];
  agents?: { id: string; meta?: unknown; lines?: unknown[] }[];
  configDirs?: number;
}): string[] {
  const dirs: string[] = [];
  for (let i = 0; i < (opts.configDirs ?? 1); i++) {
    const configDir = mkdtempSync(join(tmpdir(), 'x056-wf-'));
    const session = join(configDir, 'projects', '-proj', opts.sessionId);
    const run = join(session, 'subagents', 'workflows', opts.runId);
    mkdirSync(run, { recursive: true });
    if (opts.journal) {
      writeFileSync(join(run, 'journal.jsonl'), opts.journal.map((l) => JSON.stringify(l)).join('\n') + '\n');
    }
    for (const a of opts.agents ?? []) {
      writeFileSync(join(run, `agent-${a.id}.jsonl`), (a.lines ?? []).map((l) => JSON.stringify(l)).join('\n') + '\n');
      if (a.meta) writeFileSync(join(run, `agent-${a.id}.meta.json`), JSON.stringify(a.meta));
    }
    if (opts.script !== undefined) {
      const scripts = join(session, 'workflows', 'scripts');
      mkdirSync(scripts, { recursive: true });
      writeFileSync(join(scripts, `something-${opts.runId}.js`), opts.script);
    }
    dirs.push(configDir);
  }
  return dirs;
}

const SCRIPT = `export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  phases: [
    { title: 'Review', detail: 'five lenses over the diff' },
    { title: 'Verify' },
  ],
}
const DIMENSIONS = [{key: 'bugs'}]
`;

describe('parseWorkflowMeta', () => {
  it('reads name, description and phases from the meta literal', () => {
    expect(parseWorkflowMeta(SCRIPT)).toEqual({
      name: 'review-changes',
      description: 'Review changed files across dimensions, verify each finding',
      phases: [{ title: 'Review', detail: 'five lenses over the diff' }, { title: 'Verify', detail: undefined }],
    });
  });

  it('degrades to no metadata rather than throwing on a script it cannot read', () => {
    expect(parseWorkflowMeta('const x = 1 // no meta here')).toEqual({
      name: undefined, description: undefined, phases: [],
    });
  });

  // The meta block is a pure literal by contract, so it is matched, never run.
  it('does not execute the script', () => {
    const hostile = `export const meta = { name: 'x', description: 'y', phases: [] }\nthrow new Error('executed')`;
    expect(() => parseWorkflowMeta(hostile)).not.toThrow();
    expect(parseWorkflowMeta(hostile).name).toBe('x');
  });
});

describe('listWorkflowRuns', () => {
  it('reports declared phases and live progress from the journal', () => {
    const dirs = runOnDisk({
      sessionId: 's1', runId: 'wf_abc123', script: SCRIPT,
      journal: [
        { type: 'started', agentId: 'a1' },
        { type: 'started', agentId: 'a2' },
        { type: 'result', agentId: 'a1', result: { big: 'payload' } },
      ],
      agents: [{ id: 'a1' }, { id: 'a2' }],
    });

    const runs = listWorkflowRuns(dirs, 's1');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runId: 'wf_abc123',
      name: 'review-changes',
      started: 2,
      finished: 1,
    });
    expect(runs[0].phases.map((p) => p.title)).toEqual(['Review', 'Verify']);
  });

  // The accounts share one projects/ tree, so every run is reachable through
  // each config dir. Listing it once per account made three runs out of one.
  it('lists a run once even when several config dirs see it', () => {
    const dirs = runOnDisk({
      sessionId: 's1', runId: 'wf_shared', configDirs: 3,
      journal: [{ type: 'started', agentId: 'a1' }],
      agents: [{ id: 'a1' }],
    });
    expect(listWorkflowRuns(dirs, 's1').map((r) => r.runId)).toEqual(['wf_shared']);
  });

  it('still lists a run whose script is gone', () => {
    const dirs = runOnDisk({ sessionId: 's1', runId: 'wf_noscript', journal: [{ type: 'started', agentId: 'a1' }] });
    const runs = listWorkflowRuns(dirs, 's1');
    expect(runs).toHaveLength(1);
    expect(runs[0].name).toBeUndefined();
    expect(runs[0].started).toBe(1);
  });
});

describe('listWorkflowAgents', () => {
  it('takes completion from the journal, not from file mtime', () => {
    const dirs = runOnDisk({
      sessionId: 's1', runId: 'wf_x',
      journal: [
        { type: 'started', agentId: 'done1' },
        { type: 'started', agentId: 'busy1' },
        { type: 'result', agentId: 'done1', result: 'ok' },
      ],
      agents: [
        { id: 'done1', meta: { agentType: 'workflow-subagent', spawnDepth: 1 },
          lines: [{ type: 'user', message: { role: 'user', content: 'review the bugs lens' } }] },
        // An agent thinking hard has a fresh mtime and no result -- it must not
        // be reported as finished.
        { id: 'busy1', meta: { agentType: 'workflow-subagent', spawnDepth: 1 },
          lines: [{ type: 'user', message: { role: 'user', content: 'verify the finding' } }] },
      ],
    });

    const agents = listWorkflowAgents(workflowRunDir(dirs, 's1', 'wf_x')!);
    expect(agents.map((a) => [a.agentId, a.done])).toEqual(
      expect.arrayContaining([['done1', true], ['busy1', false]]),
    );
    expect(agents.find((a) => a.agentId === 'done1')!.brief).toContain('review the bugs lens');
  });

  it('keeps an agent that has not flushed its meta yet', () => {
    const dirs = runOnDisk({
      sessionId: 's1', runId: 'wf_y',
      journal: [{ type: 'started', agentId: 'fresh' }],
      agents: [{ id: 'fresh', lines: [{ type: 'user', message: { role: 'user', content: 'just started' } }] }],
    });
    const agents = listWorkflowAgents(workflowRunDir(dirs, 's1', 'wf_y')!);
    expect(agents).toHaveLength(1);
    expect(agents[0].agentType).toBe('workflow-subagent');
  });
});

describe('readWorkflowAgentPage', () => {
  const dirs = runOnDisk({
    sessionId: 's1', runId: 'wf_read',
    journal: [{ type: 'started', agentId: 'a1' }],
    agents: [{ id: 'a1', lines: [
      { type: 'user', message: { role: 'user', content: 'do the thing' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'did it' }] } },
    ] }],
  });

  it('pages an agent transcript with the shared reader', () => {
    const page = readWorkflowAgentPage(dirs, 's1', 'wf_read', 'a1');
    expect(page.rows.map((r) => r.role)).toEqual(['user', 'assistant']);
  });

  // Both ids arrive from a query string; a traversal in either must not escape.
  it('refuses a traversal in the run id or the agent id', () => {
    expect(readWorkflowAgentPage(dirs, 's1', 'wf_../../etc', 'a1').rows).toEqual([]);
    expect(readWorkflowAgentPage(dirs, 's1', 'wf_read', '../../../etc/passwd').rows).toEqual([]);
    expect(workflowRunDir(dirs, 's1', '../escape')).toBeNull();
  });

  it('refuses an agent that is not in this run', () => {
    expect(readWorkflowAgentPage(dirs, 's1', 'wf_read', 'not-here').rows).toEqual([]);
  });
});

describe('liveness', () => {
  // The journal only gains a line when an agent STARTS or RETURNS, and the
  // directory mtime only moves when a file is added. Agents that think for ten
  // minutes touch neither, so a working run read as long-stalled and the panel
  // hid it. Their own transcripts are the heartbeat.
  it('takes updatedAt from the agent transcripts, not just the journal', async () => {
    const dirs = runOnDisk({
      sessionId: 's1', runId: 'wf_beat',
      journal: [{ type: 'started', agentId: 'a1' }, { type: 'started', agentId: 'a2' }],
      agents: [{ id: 'a1' }, { id: 'a2' }],
    });
    const dir = workflowRunDir(dirs, 's1', 'wf_beat')!;

    const { utimesSync, writeFileSync: wf } = await import('node:fs');
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(join(dir, 'journal.jsonl'), old, old);
    utimesSync(dir, old, old);
    // ...but one agent is still writing right now.
    wf(join(dir, 'agent-a1.jsonl'), '{"type":"assistant"}\n');

    const run = listWorkflowRuns(dirs, 's1')[0];
    expect(Date.now() - run.updatedAt!).toBeLessThan(60_000);
  });
});

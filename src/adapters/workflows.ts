import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readFilePage, type HistoryPage } from './claude.js';
import { cachedBrief, type SubagentMeta } from './subagents.js';

/**
 * Workflow runs, as Claude Code already records them.
 *
 * A `Workflow` call writes its agents beside the session, in a directory per
 * RUN, using the same file shapes as an ordinary subagent:
 *
 *   <configDir>/projects/<projectDir>/<sessionId>/subagents/workflows/wf_<runId>/
 *       journal.jsonl                one {type:'started'|'result', key, agentId}
 *                                    line per agent, appended live
 *       agent-<agentId>.jsonl        full transcript, same entry shapes
 *       agent-<agentId>.meta.json    {agentType, spawnDepth}
 *
 * and the script it ran at
 *
 *   <configDir>/projects/<projectDir>/<sessionId>/workflows/scripts/<name>-wf_<runId>.js
 *
 * Because the agent files are byte-identical in shape to a plain subagent's,
 * `readSubagentPage` opens one with no special casing and the cost scanner
 * already prices them.
 *
 * What is NOT recorded: the `label` and `phase` you pass to `agent()`. Neither
 * the journal nor `agent-*.meta.json` carries them -- checked against a run that
 * used both. `meta.phases` survives only in the script file, and a per-agent
 * name has to come from the head of its own transcript. So this module reports
 * the phases a run DECLARED, not which agent belonged to which.
 */

export interface WorkflowAgent {
  agentId: string;
  agentType: string;
  spawnDepth: number;
  /** First line of the agent's own prompt -- the only per-agent label there is. */
  brief: string;
  /** A journal `result` line was written for it. */
  done: boolean;
  bytes: number;
  updatedAt?: number;
}

export interface WorkflowPhase {
  title: string;
  detail?: string;
}

export interface WorkflowRun {
  runId: string;
  dir: string;
  /** From the saved script's `meta` literal; absent if the script is gone. */
  name?: string;
  description?: string;
  phases: WorkflowPhase[];
  started: number;
  finished: number;
  /** Newest mtime under the run directory -- "is this still moving". */
  updatedAt?: number;
  startedAt?: number;
}

/** Every workflow run directory for a session, across the account config dirs. */
export function workflowDirs(configDirs: string[], sessionId: string): string[] {
  const out: string[] = [];
  for (const configDir of configDirs) {
    const projects = join(configDir, 'projects');
    if (!existsSync(projects)) continue;
    let names: string[];
    try { names = readdirSync(projects); } catch { continue; }
    for (const name of names) {
      const wf = join(projects, name, sessionId, 'subagents', 'workflows');
      if (!existsSync(wf)) continue;
      let runs: string[];
      try { runs = readdirSync(wf); } catch { continue; }
      for (const r of runs) {
        // The run id comes off the filesystem, but it is also echoed back from a
        // query string elsewhere; keep the shape strict either way.
        if (!/^wf_[A-Za-z0-9_-]+$/.test(r)) continue;
        const d = join(wf, r);
        try { if (statSync(d).isDirectory()) out.push(d); } catch { /* raced */ }
      }
    }
  }
  return out;
}

/**
 * Pull `name`, `description` and `phases` out of a saved workflow script.
 *
 * The tool REQUIRES `meta` to be a pure literal -- no variables, calls or
 * interpolation -- so the fields can be read with anchored patterns rather than
 * by evaluating attacker-controlled JavaScript. Anything unparseable degrades to
 * "no metadata", never to a throw: the run's agents are the real artifact.
 */
export function parseWorkflowMeta(src: string): { name?: string; description?: string; phases: WorkflowPhase[] } {
  const head = src.slice(0, 8000);
  const str = (key: string): string | undefined => {
    const m = new RegExp(`\\b${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`).exec(head);
    return m ? m[2].replace(/\\(['"`\\])/g, '$1') : undefined;
  };
  const phases: WorkflowPhase[] = [];
  const block = /phases\s*:\s*\[([\s\S]*?)\]/.exec(head);
  if (block) {
    const re = /\{\s*title\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1(?:\s*,\s*detail\s*:\s*(['"`])((?:\\.|(?!\3).)*)\3)?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block[1]))) phases.push({ title: m[2], detail: m[4] });
  }
  return { name: str('name'), description: str('description'), phases };
}

/** The script file a run was launched from, if it is still on disk. */
export function workflowScript(runDir: string, runId: string): string | null {
  // .../<sessionId>/subagents/workflows/<runId>  ->  .../<sessionId>/workflows/scripts
  const scripts = join(runDir, '..', '..', '..', 'workflows', 'scripts');
  if (!existsSync(scripts)) return null;
  try {
    const hit = readdirSync(scripts).find((f) => f.endsWith(`${runId}.js`));
    return hit ? join(scripts, hit) : null;
  } catch { return null; }
}

interface Journal { started: Set<string>; finished: Set<string> }

function readJournal(runDir: string): Journal {
  const started = new Set<string>();
  const finished = new Set<string>();
  const path = join(runDir, 'journal.jsonl');
  if (!existsSync(path)) return { started, finished };
  let raw: string;
  // A journal holds every agent's full return value, so it reaches megabytes on
  // a large run. Only the type and agentId are needed, and both sit at the head
  // of each line, so the lines are scanned rather than parsed where possible.
  try { raw = readFileSync(path, 'utf8'); } catch { return { started, finished }; }
  for (const line of raw.split('\n')) {
    if (!line.startsWith('{')) continue;
    const id = /"agentId"\s*:\s*"([^"]+)"/.exec(line)?.[1];
    if (!id) continue;
    if (line.startsWith('{"type": "started"') || /"type"\s*:\s*"started"/.test(line.slice(0, 40))) started.add(id);
    else if (/"type"\s*:\s*"result"/.test(line.slice(0, 40))) finished.add(id);
  }
  return { started, finished };
}

/** Every workflow run of a session, newest first. */
export function listWorkflowRuns(configDirs: string[], sessionId: string): WorkflowRun[] {
  const byId = new Map<string, WorkflowRun>();
  for (const dir of workflowDirs(configDirs, sessionId)) {
    const runId = dir.slice(dir.lastIndexOf('/') + 1);
    const { started, finished } = readJournal(dir);
    let meta: { name?: string; description?: string; phases: WorkflowPhase[] } = { phases: [] };
    const script = workflowScript(dir, runId);
    if (script) {
      try { meta = parseWorkflowMeta(readFileSync(script, 'utf8')); } catch { /* label only */ }
    }
    let updatedAt: number | undefined;
    let startedAt: number | undefined;
    try {
      const st = statSync(dir);
      startedAt = st.birthtimeMs || st.ctimeMs;
      // The directory's mtime only moves when an entry is added or removed, and
      // the journal only gains a line when an agent STARTS or RETURNS -- it is
      // an event log, not a heartbeat. Three agents each thinking for ten
      // minutes write nothing to either, so both read as long-stalled while the
      // run is working hard. The agents' own transcripts are the heartbeat.
      updatedAt = st.mtimeMs;
      const j = join(dir, 'journal.jsonl');
      if (existsSync(j)) updatedAt = Math.max(updatedAt, statSync(j).mtimeMs);
      // Only for a run that could still be alive: a finished run's liveness is
      // not a question, and this is one stat per agent.
      if (finished.size < started.size) {
        for (const f of readdirSync(dir)) {
          if (!f.startsWith('agent-') || !f.endsWith('.jsonl')) continue;
          try { updatedAt = Math.max(updatedAt, statSync(join(dir, f)).mtimeMs); } catch { /* raced */ }
        }
      }
    } catch { /* raced */ }
    const run: WorkflowRun = {
      runId, dir, ...meta,
      started: started.size,
      finished: finished.size,
      startedAt, updatedAt,
    };
    // The accounts share one `projects/` tree, so the same run is reachable
    // through every configDir and would otherwise be listed once per account.
    // Keep whichever view saw the most agents -- a partially-synced copy should
    // never mask the complete one.
    const seen = byId.get(runId);
    if (!seen || run.started > seen.started) byId.set(runId, run);
  }
  return [...byId.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/** One run's agents, with the only label each of them has. */
export function listWorkflowAgents(runDir: string): WorkflowAgent[] {
  const { finished } = readJournal(runDir);
  let names: string[];
  try { names = readdirSync(runDir); } catch { return []; }
  const out: WorkflowAgent[] = [];
  for (const f of names) {
    const m = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(f);
    if (!m) continue;
    const agentId = m[1];
    const file = join(runDir, f);
    let bytes = 0;
    let updatedAt: number | undefined;
    try { const st = statSync(file); bytes = st.size; updatedAt = st.mtimeMs; } catch { /* raced */ }
    let agentType = 'workflow-subagent';
    let spawnDepth = 1;
    try {
      const raw = JSON.parse(readFileSync(join(runDir, `agent-${agentId}.meta.json`), 'utf8')) as Record<string, unknown>;
      if (typeof raw.agentType === 'string') agentType = raw.agentType;
      if (typeof raw.spawnDepth === 'number') spawnDepth = raw.spawnDepth;
    } catch { /* a running agent may not have flushed meta yet */ }
    out.push({
      agentId, agentType, spawnDepth,
      brief: cachedBrief(file),
      // The journal is the authority on completion. File mtime is not: an agent
      // thinking hard looks identical to one that finished.
      done: finished.has(agentId),
      bytes, updatedAt,
    });
  }
  out.sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
  return out;
}

/** Resolve a run id from a query string against what is actually on disk. */
export function workflowRunDir(configDirs: string[], sessionId: string, runId: string): string | null {
  if (!/^wf_[A-Za-z0-9_-]+$/.test(runId)) return null;
  return workflowDirs(configDirs, sessionId).find((d) => d.endsWith(`/${runId}`)) ?? null;
}

/**
 * One workflow agent's transcript, paged by the same reader the session and the
 * plain subagents use -- the file shapes are identical.
 *
 * `runId` and `agentId` both arrive from a query string, so both are matched
 * against what is actually on disk before they reach a path: pasting `../` into
 * either would otherwise walk out of the session.
 */
export function readWorkflowAgentPage(
  configDirs: string[],
  sessionId: string,
  runId: string,
  agentId: string,
  limit = 200,
  before?: number,
): HistoryPage {
  const dir = workflowRunDir(configDirs, sessionId, runId);
  if (!dir) return { rows: [], cursor: 0, done: true };
  const known = listWorkflowAgents(dir).some((a) => a.agentId === agentId);
  if (!known) return { rows: [], cursor: 0, done: true };
  return readFilePage(join(dir, `agent-${agentId}.jsonl`), limit, before);
}

export type { SubagentMeta };

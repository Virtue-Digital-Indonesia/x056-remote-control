import type { ProviderId } from '../src/provider.js';

/**
 * The agent team: the tree from the "advisor + Jev" thread, per conversation.
 *
 *   main session (the conversation's own model/effort) plans and decides
 *   ├─ explorer    reads the code
 *   ├─ worker      edits and runs tests
 *   └─ researcher  pulls the docs            all three on medium effort
 *   advisor on call (if the Advisor helper is on) -- subagents inherit it
 *   Jev fork layer: small forks (which file, which tool, which subagent,
 *   retry or stop) go to `quick_decision`; a sharp answer is followed, a
 *   split one goes back to the main model.
 *
 * Nothing here is installed into an account. Claude gets the three agents on
 * argv (`--agents`, session-scoped), Codex gets the subagent effort as thread
 * config and uses its own built-in `explorer`/`worker` roles; both get the
 * instructions below appended to the system prompt. Turning the team off is a
 * respawn with `--resume`, like toggling the advisor.
 */

export const TEAM_EFFORT = 'medium';

// Read-only roles lose the editing tools rather than getting an allowlist: an
// allowlist would also strip the MCP tools (quick_decision, codegraph).
const READ_ONLY = ['Edit', 'Write', 'NotebookEdit'];

interface AgentDef { description: string; prompt: string; model: string; effort: string; disallowedTools?: string[] }

const AGENTS: Record<string, Omit<AgentDef, 'model' | 'effort'>> = {
  explorer: {
    description: 'Reads and maps the codebase: finds where things are defined and called, traces flows, answers specific questions about existing code. Read-only. Use proactively before planning changes, and spawn several in parallel for independent questions.',
    prompt: 'You are the explorer on a small agent team. Answer the question you were given about the codebase, precisely and with file:line references. Read, search and run read-only commands only; never edit files. Report what you found, what you ruled out, and anything surprising. Keep the report short: the main session acts on it.',
    disallowedTools: READ_ONLY,
  },
  worker: {
    description: 'Makes a bounded code change and verifies it: edits files in a clear write scope, runs the tests or build, and reports the result. Use for concrete implementation subtasks once the approach is decided.',
    prompt: 'You are the worker on a small agent team. Make exactly the change you were asked for, within the files it names, then run the relevant tests or build and report the result with the exact failing output if anything fails. Do not widen the scope, refactor unrelated code, commit, push or deploy. If the instructions turn out to be wrong, stop and say why instead of improvising.',
  },
  researcher: {
    description: 'Pulls external documentation and references: library and API docs, changelogs, error messages, specs. Use when the answer is outside this repository.',
    prompt: 'You are the researcher on a small agent team. Find the authoritative answer in documentation, changelogs or specs, and quote the relevant part with its source URL. Say plainly when the docs do not cover it or disagree with each other. Never edit files.',
    disallowedTools: READ_ONLY,
  },
};

/** `--agents` JSON for Claude: the three roles on Opus, effort medium. */
export function claudeTeamAgents(): string {
  return JSON.stringify(Object.fromEntries(Object.entries(AGENTS).map(([name, a]) => [name, { ...a, model: 'opus', effort: TEAM_EFFORT }])));
}

/** Thread config for Codex: its built-in roles, on medium effort. */
export function codexTeamConfig(): Record<string, unknown> {
  return { agents: { default_subagent_reasoning_effort: TEAM_EFFORT } };
}

/** What the main session is told about its team. */
export function teamInstructions(provider: ProviderId, opts: { advisor: boolean; forks: boolean }): string {
  const roles = provider === 'codex'
    ? 'Delegate with spawn_agent: agent_type "explorer" to read and map code (spawn several in parallel for independent questions), "worker" for a bounded code change plus its tests, and "default" with a research brief (docs, changelogs, specs, with source URLs) as the researcher. Subagents run at medium reasoning effort.'
    : 'Delegate with the Agent tool: "explorer" to read and map code (run several in parallel for independent questions), "worker" for a bounded code change plus its tests, "researcher" for external docs. They run on Opus at medium effort.';
  // Saying HOW to spawn was not enough: a Codex chat with the team on ran a
  // 28-command turn alone (2026-09-30) after 218 solo turns. So: when, and a
  // one-line account of the choice before starting.
  const lines = [
    'AGENT TEAM MODE. You are the main session: you plan, decide, integrate and verify; your team does the legwork. This holds from this turn on, even if earlier turns in this conversation worked alone.',
    roles,
    'Spawn instead of doing it yourself when: (1) you need to read or search code you have not already read in this turn -- send explorers, several in parallel for independent questions; (2) a change touches more than one file or area -- give each independent part to its own worker, with its files and the tests to run; (3) the answer is outside the repository (docs, changelogs, specs) -- send the researcher. Work alone only for a one-file edit you already understand, a single command, or an answer from what is already in context.',
    'Before the first command of a multi-step task, say in one line which subagents you are spawning and for what, or why this task is small enough to do alone.',
    'Keep for yourself: the plan, decisions with real trade-offs, reviewing what the team returns, and the final verification. Give each subagent a self-contained brief (goal, files, what to report) because it does not see this conversation.',
  ];
  if (opts.forks) lines.push('FORK LAYER. For small routine forks that need no deep thinking -- which file to open first, which tool or subagent to use, whether to retry a failed step or stop -- call the x056 tool quick_decision with the question, 2 to 6 short options and one line of context. It answers in well under a second. If it says SHARP, follow it. If it says SPLIT, the choice is genuinely close: decide yourself. Do not use it for design decisions or anything the user must decide.');
  if (opts.advisor) lines.push(provider === 'codex'
    ? 'An advisor model reviews your plan, repeated failures and the finished turn; apply its advice when it arrives.'
    : 'Consult the advisor before committing to a large plan, when the same error comes back, and before calling a long task done. Subagents can consult it too.');
  return lines.join('\n');
}

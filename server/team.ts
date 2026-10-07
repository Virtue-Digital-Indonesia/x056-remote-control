import type { ProviderId } from '../src/provider.js';
import { ADVISOR_LINE_PREFIX, TEAM_LINE_PREFIX } from '../src/message-sender.js';

/**
 * The agent team: the tree from the "advisor + Jev" thread, per conversation.
 *
 *   main session (the conversation's own model/effort) plans and decides
 *   ├─ explorer    reads the code
 *   ├─ worker      edits and runs tests
 *   └─ researcher  pulls the docs            medium effort unless Jev picks
 *   advisor on call (if the Advisor helper is on) -- subagents inherit it
 *   Jev fork layer: small forks (which file, which tool, which subagent,
 *   retry or stop) go to `quick_decision`; a sharp answer is followed, a
 *   split one goes back to the main model.
 *
 * Jev (or OpenAI Decisions), when on, picks the subagents' model and effort
 * per turn. That choice is named in the turn's MESSAGE (`teamTurnLine`),
 * never here: everything below is process identity, constant per
 * conversation, and a per-turn value in it would respawn the process each
 * turn. Claude's Agent tool takes a model per call but no effort, so each role
 * is defined at three efforts (`explorer`, `explorer-low`, `explorer-high`).
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

/** The Claude effort variants of each role: the plain name is medium. */
export const CLAUDE_TEAM_EFFORTS = ['low', 'medium', 'high'] as const;
const roleName = (role: string, effort: string) => effort === TEAM_EFFORT ? role : `${role}-${effort}`;

/** `--agents` JSON for Claude: the three roles on Opus, each at low, medium
 *  (the plain name) and high effort. Constant, so the process identity is. */
export function claudeTeamAgents(): string {
  const out: Record<string, AgentDef> = {};
  for (const [name, a] of Object.entries(AGENTS)) {
    // The plain (medium) name first, then its variants.
    for (const effort of [TEAM_EFFORT, ...CLAUDE_TEAM_EFFORTS.filter((e) => e !== TEAM_EFFORT)]) {
      out[roleName(name, effort)] = { ...a, ...(effort === TEAM_EFFORT ? {} : { description: `${a.description} This variant runs at ${effort} effort: use it when the message names it.` }), model: 'opus', effort };
    }
  }
  return JSON.stringify(out);
}

/**
 * The one line appended to a turn's message for the agent team.
 *
 * Codex: EVERY turn with the team on, picker or not. Codex 0.159 follows our
 * team brief with its own developer message ("Any earlier instruction enabling
 * proactive multi-agent delegation no longer applies. Do not spawn sub-agents
 * unless the user ... explicitly ask[s]"), lifted only at effort "ultra", so
 * the brief alone produced 0 spawns in 28 turns (2026-10-01). The request has
 * to come from the user's message. It still allows a solo turn for simple work,
 * as the owner asked. spawn_agent takes model and reasoning_effort per call.
 *
 * Claude: when a picker chose the team's model/effort (the Agent tool takes
 * the model per call, the effort through the variant's name), and, with a
 * fork backend, on every team turn: the fork layer was in the brief alone and
 * Claude made 0 quick_decision calls against Codex's 113 (2026-09-30..10-07),
 * the per-turn line being what moved Codex. Returns undefined when there is
 * nothing to say.
 */
export function teamTurnLine(provider: ProviderId, team?: { model?: string; effort: string }, backend: 'jev' | 'openai' = 'jev', opts: { forks?: boolean } = {}): string | undefined {
  const by = backend === 'openai' ? 'OpenAI Decisions' : 'Jev';
  if (provider === 'codex') {
    const what = team ? [team.model ? `model "${team.model}"` : '', `reasoning_effort "${team.effort}"`].filter(Boolean).join(' and ') : '';
    return `${TEAM_LINE_PREFIX}I am asking you to delegate this turn as the agent team brief says: spawn_agent explorers for code you have not read (several in parallel), a worker for each independent change, a default agent as researcher for outside docs`
      + (what ? `, passing ${what} on every spawn_agent call (picked by ${by})` : '')
      + '. If the turn is small enough to do alone (one command, a one-file edit you already understand, a single deploy, a direct answer), do it alone and say why in one line.]';
  }
  const forks = opts.forks ? ' Use quick_decision for small either-or forks (which file, which tool, retry or stop).' : '';
  if (!team) return forks ? `${TEAM_LINE_PREFIX}delegate the legwork to explorer, worker and researcher as the team brief says.${forks}]` : undefined;
  const effort = (CLAUDE_TEAM_EFFORTS as readonly string[]).includes(team.effort) ? team.effort : TEAM_EFFORT;
  const names = Object.keys(AGENTS).map((r) => roleName(r, effort));
  const types = `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
  return `${TEAM_LINE_PREFIX}call the Agent tool with ${team.model ? `model "${team.model}" and ` : ''}subagent_type ${types}. Picked by ${by}.${forks}]`;
}

/**
 * The advisor's per-turn line, Claude only (ChatGPT's advisor is run by the
 * gateway). Claude Code's advisor is model-driven, and its only guidance was
 * one sentence in the TEAM brief: some conversations with it on made 5 calls
 * in 88 turns. Like the team line it rides in the MESSAGE, never the system
 * prompt, which is process identity; `stripTeamLine` removes it on read-back.
 */
export function advisorTurnLine(provider: ProviderId): string | undefined {
  return provider === 'claude' ? `${ADVISOR_LINE_PREFIX}consult it before committing to an approach on multi-step work, when stuck, and before declaring done.]` : undefined;
}

/** Thread config for Codex: its built-in roles, on medium effort. */
export function codexTeamConfig(): Record<string, unknown> {
  return { agents: { default_subagent_reasoning_effort: TEAM_EFFORT } };
}

/** What the main session is told about its team. */
export function teamInstructions(provider: ProviderId, opts: { advisor: boolean; forks: boolean }): string {
  const roles = provider === 'codex'
    ? 'Delegate with spawn_agent: agent_type "explorer" to read and map code (spawn several in parallel for independent questions), "worker" for a bounded code change plus its tests, and "default" with a research brief (docs, changelogs, specs, with source URLs) as the researcher. When a message carries an "[Agent team this turn: ...]" line, pass the model and reasoning_effort it names on every spawn_agent call in that turn; otherwise subagents run at medium reasoning effort.'
    : 'Delegate with the Agent tool: "explorer" to read and map code (run several in parallel for independent questions), "worker" for a bounded code change plus its tests, "researcher" for external docs. When a message carries an "[Agent team this turn: ...]" line, use the model and the subagent_type variants it names (e.g. explorer-high) for every subagent in that turn; otherwise they run on Opus at medium effort.';
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

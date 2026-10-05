import type { JevCandidate, TeamPickInput } from './jev.js';
import type { ProviderModel } from '../src/provider.js';

/**
 * What the per-conversation decision maker means for one turn.
 *
 * `advisor` on Claude: pass `--advisor`. The pairing is chosen here, not by the
 * user -- verified on 2.1.280: an Opus advisor on a Fable main model is not an
 * error, Claude Code just warns and runs WITHOUT the advisor, which would read
 * as "on" while doing nothing. So a Fable main model gets a Fable advisor and
 * everything else gets Opus (accepted for Haiku, Sonnet and Opus mains).
 */
export function advisorFor(provider: 'claude' | 'codex', model: string | undefined): string | undefined {
  if (provider !== 'claude') return undefined;
  return /fable/i.test(model || '') ? 'fable' : 'opus';
}

/** What Jev may choose between on Claude. Haiku is left out (owner,
 *  2026-10-05): its context window is too short for these conversations.
 *  Fable is in (owner, same day), although it bills to usage credits. A user
 *  can still pick Haiku by hand. */
export const CLAUDE_CANDIDATES: JevCandidate[] = [
  { id: 'sonnet', about: 'Strong everyday model. Normal coding, writing, explanations, features of moderate size.' },
  { id: 'opus', about: 'Strongest affordable reasoning. Hard debugging, architecture, large or risky refactors, ambiguous problems.' },
  { id: 'fable', about: 'Frontier model, billed to usage credits. Only the hardest work: deep multi-step reasoning, critical or very large changes.' },
];

/**
 * What Claude Code runs with when no --effort is given (docs, model-config:
 * "high on every model that supports effort, except that Opus 5.5 and Sonnet
 * 5.5 default to medium"). Aliases as they resolve here, checked against real
 * transcripts 2026-09-30: opus -> claude-opus-5-5, sonnet -> claude-sonnet-5,
 * fable -> claude-fable-5-1. Haiku 4.5 takes no effort, so it has no entry.
 */
/** What "Auto model" runs when the picker cannot decide: the house defaults,
 *  a balanced everyday model rather than the frontier one each CLI would pick.
 *  The panel's AUTO_MODEL is the same table. */
export const AUTO_MODEL: Record<'claude' | 'codex', string> = { claude: 'sonnet', codex: 'gpt-5.6-terra' };

export const CLAUDE_DEFAULT_EFFORT: Record<string, string> = {
  opus: 'medium', 'claude-opus-5-5': 'medium', sonnet: 'high', 'claude-sonnet-5': 'high', fable: 'high', 'claude-fable-5-1': 'high',
};

export const EFFORT_CRITERIA: Record<string, string> = {
  low: 'Trivial: a quick answer, a lookup, a mechanical one-line change.',
  medium: 'Ordinary: a normal edit, explanation, or small feature.',
  high: 'Hard: multi-step work, debugging, changes across several files.',
  xhigh: 'Very hard: a large refactor, a subtle bug, careful reasoning throughout.',
  max: 'Exceptional difficulty where thoroughness matters far more than cost.',
  ultra: 'Exceptional difficulty; the most reasoning the model offers.',
};

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const CODEX_FAMILIES = /-(luna|terra|sol|astra)$/;

/** Candidates for one turn. Codex uses the models the accounts actually offer. */
export function jevCandidates(provider: 'claude' | 'codex', codexModels: ProviderModel[]): { models: JevCandidate[]; efforts: Record<string, string> } {
  if (provider === 'claude') {
    return { models: CLAUDE_CANDIDATES.map((m) => ({ ...m, efforts: CLAUDE_EFFORTS })), efforts: pick(CLAUDE_EFFORTS) };
  }
  // The four current families only (owner, 2026-10-05): a legacy slug such as
  // gpt-5.5 is never offered to the picker, though a user can still choose it.
  const models = codexModels.filter((m) => CODEX_FAMILIES.test(m.slug))
    .map((m) => ({ id: m.slug, about: (m.description || m.label || m.slug).slice(0, 200), efforts: m.efforts }));
  const offered = [...new Set(models.flatMap((m) => m.efforts ?? []))].filter((e) => EFFORT_CRITERIA[e]);
  return { models, efforts: pick(offered.length ? offered : ['low', 'medium', 'high']) };
}

function pick(keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.filter((k) => EFFORT_CRITERIA[k]).map((k) => [k, EFFORT_CRITERIA[k]]));
}

/** What the agent team's subagents need, in their own terms: legwork, not the
 *  whole turn. Claude's Agent tool reaches three efforts (one agent definition
 *  per effort, see server/team.ts); Codex's spawn_agent takes any. */
export const SUBAGENT_EFFORT_CRITERIA: Record<string, string> = {
  low: 'Lookups and mapping: find where something is defined or called, read a doc page, a mechanical edit.',
  medium: 'Ordinary legwork: trace a flow, a bounded edit with its tests, a focused documentation question.',
  high: 'Hard legwork: chase a subtle bug, a change across several files, reconcile conflicting docs.',
  xhigh: 'Very hard legwork: careful reasoning throughout, a risky change to a delicate part.',
};

/**
 * The team pick's candidates. Models: the same list the main pick uses.
 * Efforts: Claude low/medium/high; Codex up to xhigh, as far as any offered
 * model goes (the policy then filters by the model actually chosen). Base:
 * Claude subagents are defined on Opus at medium; Codex children run on the
 * main session's model (absent here: resolved after the main pick) at medium.
 */
export function teamCandidates(provider: 'claude' | 'codex', models: JevCandidate[], baseEffort = 'medium'): TeamPickInput {
  const keys = provider === 'claude' ? ['low', 'medium', 'high']
    : ['low', 'medium', 'high', 'xhigh'].filter((e) => !models.length || models.some((m) => !m.efforts?.length || m.efforts.includes(e)));
  return {
    models,
    efforts: Object.fromEntries(keys.map((k) => [k, SUBAGENT_EFFORT_CRITERIA[k]])),
    ...(provider === 'claude' ? { baseModel: 'opus' } : {}),
    baseEffort,
  };
}

import type { JevCandidate } from './jev.js';
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

/** What Jev may choose between on Claude. Fable is left out on purpose: it
 *  bills to usage credits and would be picked for "hard" often enough to hurt. */
export const CLAUDE_CANDIDATES: JevCandidate[] = [
  { id: 'haiku', about: 'Fastest and cheapest. Quick answers, lookups, small mechanical edits, formatting.' },
  { id: 'sonnet', about: 'Strong everyday model. Normal coding, writing, explanations, features of moderate size.' },
  { id: 'opus', about: 'Strongest affordable reasoning. Hard debugging, architecture, large or risky refactors, ambiguous problems.' },
];

/**
 * What Claude Code runs with when no --effort is given (docs, model-config:
 * "high on every model that supports effort, except that Opus 5.5 and Sonnet
 * 5.5 default to medium"). Aliases as they resolve here, checked against real
 * transcripts 2026-09-30: opus -> claude-opus-5-5, sonnet -> claude-sonnet-5,
 * fable -> claude-fable-5-1. Haiku 4.5 takes no effort, so it has no entry.
 */
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

/** Candidates for one turn. Codex uses the models the accounts actually offer. */
export function jevCandidates(provider: 'claude' | 'codex', codexModels: ProviderModel[]): { models: JevCandidate[]; efforts: Record<string, string> } {
  if (provider === 'claude') {
    return { models: CLAUDE_CANDIDATES.map((m) => ({ ...m, efforts: CLAUDE_EFFORTS })), efforts: pick(CLAUDE_EFFORTS) };
  }
  const models = codexModels.map((m) => ({ id: m.slug, about: (m.description || m.label || m.slug).slice(0, 200), efforts: m.efforts }));
  const offered = [...new Set(models.flatMap((m) => m.efforts ?? []))].filter((e) => EFFORT_CRITERIA[e]);
  return { models, efforts: pick(offered.length ? offered : ['low', 'medium', 'high']) };
}

function pick(keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.filter((k) => EFFORT_CRITERIA[k]).map((k) => [k, EFFORT_CRITERIA[k]]));
}

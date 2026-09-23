/** Retired RC selections map at dispatch, without rewriting transcript history. */
export function currentCodexModel(model: string): string {
  return ({ 'gpt-5.6-sol': 'gpt-6-sol', 'gpt-5.6-luna': 'gpt-6-luna' } as Record<string, string>)[model] || model;
}
export function currentCodexPrefs(model: string, effort: string): { model: string; effort: string } {
  const current = currentCodexModel(model);
  // Codex 0.156.1 supports ultra on Sol, but Luna stops at max.
  return { model: current, effort: current === 'gpt-6-luna' && effort === 'ultra' ? 'max' : effort };
}

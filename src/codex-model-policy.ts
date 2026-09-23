/** Retired RC selections map at dispatch, without rewriting transcript history. */
export function currentCodexModel(model: string): string {
  return ({ 'gpt-5.6-sol': 'gpt-6-sol', 'gpt-5.6-luna': 'gpt-6-luna' } as Record<string, string>)[model] || model;
}
export function currentCodexPrefs(model: string, effort: string): { model: string; effort: string } {
  const current = currentCodexModel(model);
  // Legacy Sol allowed ultra; the GPT-6 Sol/Luna launch catalog supports max.
  return { model: current, effort: /^gpt-6-(sol|luna)$/.test(current) && effort === 'ultra' ? 'max' : effort };
}

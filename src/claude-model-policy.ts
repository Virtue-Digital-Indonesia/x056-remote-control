/** Upgrade saved Opus 5 selections while preserving transcript model IDs. */
export function currentClaudeModel(model: string): string {
  return model === 'claude-opus-5' ? 'opus' : model;
}

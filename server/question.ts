/**
 * Answering Claude's questions from the UI. Headless `claude -p` can't take
 * mid-turn input, so the feasible design (verified live against the CLI) is:
 * the model ends its turn with a question in a detectable block, the panel
 * surfaces it with quick-reply buttons, and the answer is just the next message
 * (which resumes the session with full context). We append a small convention
 * to user prompts so detection is deterministic rather than a fuzzy heuristic.
 */

export interface ParsedQuestion {
  question: string;
  options: string[];
}

// Leading sentinel so the appended block can be stripped back out for display.
export const ASK_SENTINEL = '\n\n〈x056 question protocol〉\n';
export const ASK_INSTRUCTIONS =
  ASK_SENTINEL +
  'Keep working autonomously by default. But when you genuinely need a decision only the user can make ' +
  'before continuing (and guessing would risk real rework), you may end your turn with this exact block ' +
  'as the very last thing you output:\n' +
  '<<<ASK\n' +
  'question: <your one-line question>\n' +
  'options: <option A> | <option B> | <option C>\n' +
  '>>>\n' +
  'Omit the options line for a free-form answer. The user replies in the panel and you resume with full context.';

/** Append the ASK convention to a user prompt (skip for non-interactive turns). */
export function withAskInstructions(prompt: string): string {
  return prompt + ASK_INSTRUCTIONS;
}

/** Extract a question the model left at the end of its turn, if any. */
export function parseQuestion(text: string): ParsedQuestion | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const block = /<<<ASK\s*([\s\S]*?)>>>/.exec(text);
  if (block) {
    const q = /question:\s*(.+)/i.exec(block[1]);
    if (q) {
      const optLine = /options:\s*(.+)/i.exec(block[1]);
      const options = optLine ? optLine[1].split('|').map((s) => s.trim()).filter(Boolean) : [];
      return { question: q[1].trim(), options };
    }
  }
  // Fallback: a short trailing line ending in '?' is very likely a question.
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  if (last.endsWith('?') && last.length <= 280) return { question: last, options: [] };
  return null;
}

/** Remove the raw ASK block from assistant text before display. */
export function stripAsk(text: string): string {
  return text.replace(/<<<ASK[\s\S]*?>>>/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Remove the appended ASK convention from a stored user prompt for display. */
export function stripAskInstructions(text: string): string {
  const i = text.indexOf(ASK_SENTINEL);
  return i >= 0 ? text.slice(0, i).trimEnd() : text;
}

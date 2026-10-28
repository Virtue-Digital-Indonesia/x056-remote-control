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
  /** Present when several decisions are bundled into one reply. */
  questions?: { question: string; options: string[] }[];
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
  'options: <choices separated by |; use as many as needed>\n' +
  '>>>\n' +
  'There is no fixed number of choices or questions. Repeat question/options lines inside the block for multiple decisions. Omit the options line for a free-form answer. The user replies in the panel and you resume with full context.';

/** Append the ASK convention to a user prompt (skip for non-interactive turns). */
export function withAskInstructions(prompt: string): string {
  return prompt + ASK_INSTRUCTIONS;
}

/** Extract a question the model left at the end of its turn, if any. */
export function parseQuestion(text: string): ParsedQuestion | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const questions: { question: string; options: string[] }[] = [];
  for (const block of text.matchAll(/<<<ASK\s*([\s\S]*?)>>>/g)) {
    let current: { question: string; options: string[] } | undefined;
    for (const line of block[1].split('\n')) {
      const q = /^\s*question:[ \t]*(.+)/i.exec(line);
      const options = /^\s*options:[ \t]*(.*)/i.exec(line);
      if (q) { current = { question: q[1].trim(), options: [] }; questions.push(current); }
      else if (options && current) current.options = options[1].split('|').map(s => s.trim()).filter(Boolean);
    }
  }
  if (questions.length) return { ...questions[0], ...(questions.length > 1 ? { questions } : {}) };
  // Fallback: a short trailing line ending in '?' is very likely a question.
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  if (last.endsWith('?') && last.length <= 280) return { question: last, options: [] };
  return null;
}

/** Remove the raw ASK block from assistant text before display. */
export function stripAsk(text: string): string {
  return stripResolved(text.replace(/<<<ASK[\s\S]*?>>>/g, '')).replace(/\n{3,}/g, '\n\n').trim();
}

/** The marker a reply ends with to close the questions that were open when its turn began. */
export const RESOLVED_MARKER = '<<<RESOLVED>>>';
/** True only when a line of the text, trimmed, is exactly the marker: never
 *  inline (models added it as a sign-off mid-sentence), never in backticks or
 *  inside a fenced code block. `stripResolved` still removes it anywhere. */
export function hasResolved(text: string): boolean {
  if (typeof text !== 'string' || !text.includes(RESOLVED_MARKER)) return false;
  let fenced = false;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (/^(```|~~~)/.test(t)) { fenced = !fenced; continue; }
    if (!fenced && t === RESOLVED_MARKER) return true;
  }
  return false;
}

export interface QuestionItem { question: string; options: string[] }
const normalise = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Which questions of an open batch an owner's message answers, as indexes.
 * (i) a block `N. <question>\nAnswer: <x>` (the panel's batch form, and the
 *     iOS app) answers the question with that text (whitespace and case
 *     normalised; a question may span lines, so blocks are never split on
 *     blank lines);
 * (ii) a message that IS one option (trimmed, case-insensitive) answers the
 *     first not-yet-answered question that lists it.
 * Anything else answers nothing: the card stays open.
 */
export function answeredQuestionIndexes(batch: QuestionItem[], message: string): number[] {
  const text = typeof message === 'string' ? message : '';
  const answered = new Set<number>();
  batch.forEach((item, index) => {
    const words = String(item.question ?? '').trim().split(/\s+/).filter(Boolean).map(escapeRe);
    if (!words.length) return;
    const block = new RegExp('(?:^|\\n)[ \\t]*\\d+\\.[ \\t]*' + words.join('\\s+') + '[ \\t]*\\r?\\n[ \\t]*Answer:', 'i');
    if (block.test(text)) answered.add(index);
  });
  const whole = normalise(text);
  if (whole) {
    const index = batch.findIndex((item, i) => !answered.has(i) && (item.options ?? []).some((o) => normalise(o) === whole));
    if (index >= 0) answered.add(index);
  }
  return [...answered].sort((a, b) => a - b);
}
/** The marker a reply carries (on its own line) to say an agent-started turn is for the owner. */
export const FOR_OWNER = '<<<FOR_OWNER>>>';
export function hasForOwner(text: string): boolean {
  return typeof text === 'string' && text.includes(FOR_OWNER);
}
export function stripResolved(text: string): string {
  return text.split(RESOLVED_MARKER).join('').split(FOR_OWNER).join('');
}

/** Remove the appended ASK convention from a stored user prompt for display. */
export function stripAskInstructions(text: string): string {
  const i = text.indexOf(ASK_SENTINEL);
  return i >= 0 ? text.slice(0, i).trimEnd() : text;
}

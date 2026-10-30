/**
 * Answering the model's questions from the UI. Headless `claude -p` can't take
 * mid-turn input, so the model asks with the x056 `ask_user` tool and ends its
 * turn; the panel shows the card and the answer is just the next message. The
 * `<<<ASK>>>` block below is the one-release fallback (logged as
 * `question_fallback`); see docs/question-tools-contract.md.
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
  'before continuing (and guessing would risk real rework), call the x056 tool ask_user with the question(s) ' +
  'and their options (as many as needed; none for a free-form answer), then END YOUR TURN. The user answers in ' +
  'the panel and the answer arrives as your next message, with full context. Do not ask in plain text. ' +
  'Manage open question cards with list_questions, edit_question, dismiss_question (a question that became moot) ' +
  'and answer_question. Only if the x056 tools are unavailable, end your reply instead with a block ' +
  '<<<ASK / question: <one line> / options: <a | b> / >>> (each part on its own line).';

/** Append the ASK convention to a user prompt (skip for non-interactive turns). */
export function withAskInstructions(prompt: string): string {
  return prompt + ASK_INSTRUCTIONS;
}

/** Extract a question the model left in an <<<ASK>>> block (the fallback path;
 *  the x056 ask_user tool is the primary one), if any. */
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
  // Only an explicit block counts: the old "last line ends in ?" guess turned
  // rhetorical questions into cards. ask_user is the primary path now.
  if (questions.length) return { ...questions[0], ...(questions.length > 1 ? { questions } : {}) };
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

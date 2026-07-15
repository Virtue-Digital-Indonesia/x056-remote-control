import { describe, expect, it } from 'vitest';
import { parseQuestion, stripAsk, stripAskInstructions, withAskInstructions, ASK_SENTINEL } from '../src/question.js';

describe('question parsing', () => {
  it('parses an ASK block with options', () => {
    const t = 'Some reasoning.\n\n<<<ASK\nquestion: Which database should I use?\noptions: Postgres | MySQL | SQLite\n>>>';
    expect(parseQuestion(t)).toEqual({ question: 'Which database should I use?', options: ['Postgres', 'MySQL', 'SQLite'] });
  });
  it('parses an ASK block without options (free-form)', () => {
    expect(parseQuestion('<<<ASK\nquestion: What should the app be called?\n>>>')).toEqual({ question: 'What should the app be called?', options: [] });
  });
  it('falls back to a trailing question line', () => {
    expect(parseQuestion('I did the thing.\nShould I also deploy it?')).toEqual({ question: 'Should I also deploy it?', options: [] });
  });
  it('returns null when there is no question', () => {
    expect(parseQuestion('All done. Everything passes.')).toBeNull();
    expect(parseQuestion('')).toBeNull();
  });
  it('stripAsk removes the raw block from displayed text', () => {
    expect(stripAsk('Here is my plan.\n\n<<<ASK\nquestion: ok?\n>>>')).toBe('Here is my plan.');
  });
  it('stripAskInstructions removes the appended convention from a user prompt', () => {
    const sent = withAskInstructions('build me a thing');
    expect(sent).toContain(ASK_SENTINEL.trim());
    expect(stripAskInstructions(sent)).toBe('build me a thing');
    expect(stripAskInstructions('no protocol here')).toBe('no protocol here');
  });
});

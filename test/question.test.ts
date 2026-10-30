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
  it('no longer guesses from a trailing question line (ask_user replaced it)', () => {
    expect(parseQuestion('I did the thing.\nShould I also deploy it?')).toBeNull();
  });
  it('the protocol teaches ask_user and keeps the sentinel, so old prompts still strip', () => {
    expect(ASK_SENTINEL).toBe('\n\n〈x056 question protocol〉\n');
    const sent = withAskInstructions('go');
    expect(sent).toContain('ask_user');
    expect(sent).toContain('END YOUR TURN');
    // The text block survives only as the fallback for a chat whose x056 tools did not load.
    expect(sent.indexOf('ask_user')).toBeLessThan(sent.indexOf('<<<ASK'));
    expect(sent).toContain('Only if the x056 tools are unavailable');
    // Quoting the protocol back must never open a card: the hint is not a parseable block.
    expect(parseQuestion(sent)).toBeNull();
    const old = 'go' + ASK_SENTINEL + 'Keep working autonomously by default. ... <<<ASK\nquestion: x\n>>>';
    expect(stripAskInstructions(old)).toBe('go');
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


it('accepts fewer or more than three options without padding or truncation', () => {
  for(const count of [0,1,2,4,8]) {
    const options=Array.from({length:count},(_,i)=>'Choice '+i);
    expect(parseQuestion('<<<ASK\nquestion: Pick?\noptions: '+options.join(' | ')+'\n>>>')).toEqual({question:'Pick?',options});
  }
});
it('keeps every question in one block or successive blocks, including free text', () => {
  const text='<<<ASK\nquestion: First?\noptions: A | B\nquestion: Second?\nquestion: Third?\noptions: C | D | E | F\n>>>\n<<<ASK\nquestion: Fourth?\n>>>';
  expect(parseQuestion(text)?.questions).toEqual([{question:'First?',options:['A','B']},{question:'Second?',options:[]},{question:'Third?',options:['C','D','E','F']},{question:'Fourth?',options:[]}]);
});

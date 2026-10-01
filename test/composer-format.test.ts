import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

// The module is a browser script with a CommonJS guard; load it the same way.
const source = readFileSync(resolve('server/public/composer-format.js'), 'utf8');
const sandbox: { module: { exports: any } } = { module: { exports: {} } };
vm.runInNewContext(source, sandbox);
const F = sandbox.module.exports;

/** `|` marks the caret, `[` `]` a selection. */
function parse(text: string) {
  const sel = text.indexOf('['), caret = text.indexOf('|');
  if (sel >= 0) { const end = text.indexOf(']'); return { value: text.replace('[', '').replace(']', ''), start: sel, end: end - 1 }; }
  return { value: text.replace('|', ''), start: caret, end: caret };
}
function show(st: { value: string; start: number; end: number }) {
  if (st.start === st.end) return st.value.slice(0, st.start) + '|' + st.value.slice(st.start);
  return st.value.slice(0, st.start) + '[' + st.value.slice(st.start, st.end) + ']' + st.value.slice(st.end);
}
const run = (id: string, text: string, opts?: unknown) => show(F.apply(id, parse(text), opts));
// The panel's own list display conversion, enough for the block transforms.
const opts = {
  toMarkdown: (s: string) => s.replace(/^ {2}([ \t]*)•(?= )/gm, '$1-').replace(/^ {2}([ \t]*\d)/gm, '$1'),
  toDisplay: (s: string) => s.replace(/^([ \t]*)[-*+](?= )/gm, '  $1•').replace(/^([ \t]*\d{1,9}[.)] )/gm, '  $1'),
};

describe('composer formatting: inline markers', () => {
  it('wraps a selection and keeps it selected', () => {
    expect(run('bold', 'say [hello] there')).toBe('say **[hello]** there');
    expect(run('italic', 'say [hello] there')).toBe('say *[hello]* there');
    expect(run('code', 'run [npm test] now')).toBe('run `[npm test]` now');
    expect(run('underline', 'a [word] b')).toBe('a <u>[word]</u> b');
  });
  it('keeps surrounding spaces outside the markers', () => {
    expect(run('bold', 'say[ hello ]there')).toBe('say **[hello]** there');
  });
  it('toggles off whether the markers are outside or inside the selection', () => {
    expect(run('bold', 'say **[hello]** there')).toBe('say [hello] there');
    expect(run('bold', 'say [**hello**] there')).toBe('say [hello] there');
    expect(run('underline', 'a <u>[word]</u> b')).toBe('a [word] b');
    expect(run('code', '[`x`]')).toBe('[x]');
  });
  it('tells bold and italic apart', () => {
    expect(run('italic', '**[bold]**')).toBe('***[bold]***');
    expect(run('italic', '***[bold]***')).toBe('**[bold]**');
    expect(run('bold', '*[it]*')).toBe('***[it]***');
    expect(run('italic', '[**bold**]')).toBe('*[**bold**]*');
  });
  it('inserts a pair at the caret, removes an empty pair, steps out of a filled one', () => {
    expect(run('bold', 'a |b')).toBe('a **|**b');
    expect(run('bold', 'a **|**b')).toBe('a |b');
    expect(run('bold', 'a **bold|** b')).toBe('a **bold**| b');
    expect(run('code', 'x `y|` z')).toBe('x `y`| z');
    expect(run('underline', '<u>u|</u>')).toBe('<u>u</u>|');
    expect(run('italic', '|')).toBe('*|*');
  });
  it('wraps a multi-line selection line by line, inside list and quote prefixes', () => {
    expect(run('bold', '[  • one\n  • two]')).toBe('[  • **one**\n  • **two**]');
    expect(run('bold', '[  • **one**\n  • **two**]')).toBe('[  • one\n  • two]');
    expect(run('italic', '[> a\n\n> b]')).toBe('[> *a*\n\n> *b*]');
  });
});

describe('composer formatting: blocks', () => {
  it('quotes the current line and every selected line, and takes it off again', () => {
    expect(run('quote', 'hel|lo')).toBe('> hel|lo');
    expect(run('quote', '> hel|lo')).toBe('hel|lo');
    expect(run('quote', '[one\n\ntwo]')).toBe('[> one\n>\n> two]');
    expect(run('quote', '[> one\n>\n> two]')).toBe('[one\n\ntwo]');
    expect(run('quote', '|')).toBe('> |');
  });
  it('quotes composer bullets as Markdown and restores them', () => {
    expect(run('quote', '[  • a\n  • b]', opts)).toBe('[> - a\n> - b]');
    expect(run('quote', '[> - a\n> - b]', opts)).toBe('[  • a\n  • b]');
  });
  it('places a horizontal rule on its own line with a blank line above', () => {
    expect(run('rule', 'Title|')).toBe('Title\n\n---\n|');
    expect(run('rule', '|')).toBe('---\n|');
    expect(run('rule', 'a\n|')).toBe('a\n\n---\n|');
    expect(run('rule', 'a\n\n|')).toBe('a\n\n---\n|');
    expect(run('rule', 'a|\nb')).toBe('a\n\n---\n|\nb');
    expect(run('rule', 'a|\n\nb')).toBe('a\n\n---\n|\nb');
  });
  it('opens an empty fence, removes it again, fences and unfences a selection', () => {
    expect(run('fence', '|')).toBe('```\n|\n```');
    expect(run('fence', '```\n|\n```')).toBe('|');
    expect(run('fence', 'text|')).toBe('text\n```\n|\n```');
    expect(run('fence', 'a\n[x = 1\ny = 2]\nb')).toBe('a\n```\n[x = 1\ny = 2]\n```\nb');
    expect(run('fence', 'a\n```\n[x = 1\ny = 2]\n```\nb')).toBe('a\n[x = 1\ny = 2]\nb');
    expect(run('fence', '[```\nx\n```]')).toBe('[x]');
    expect(run('fence', '[  • a]', opts)).toBe('```\n[- a]\n```');
  });
  it('toggles bullet and numbered lists in the composer style', () => {
    expect(run('bullet', '|')).toBe('  • |');
    expect(run('bullet', 'it|em')).toBe('  • it|em');
    expect(run('bullet', '  • it|em')).toBe('it|em');
    expect(run('bullet', '[a\nb\n\nc]')).toBe('[  • a\n  • b\n\n  • c]');
    expect(run('bullet', '[  • a\n    • b]')).toBe('[a\n  b]');
    expect(run('number', '[a\nb]')).toBe('[  1. a\n  2. b]');
    expect(run('number', '[  • a\n  • b]')).toBe('[  1. a\n  2. b]');
    expect(run('bullet', '[  1. a\n  2. b]')).toBe('[  • a\n  • b]');
    expect(run('number', '[  1. a\n  2. b]')).toBe('[a\nb]');
    expect(run('bullet', '[> a\n> b]')).toBe('[> - a\n> - b]');
    expect(run('bullet', '```\n|x\n```')).toBe('```\n|x\n```');
  });
});

describe('composer formatting: shortcuts', () => {
  const key = (k: string, code: string, mods: Record<string, boolean> = {}) => ({ key: k, code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });
  const id = (e: object, mac: boolean) => F.shortcutFor(e, mac)?.id ?? null;
  it('uses Cmd on a Mac and Ctrl elsewhere', () => {
    expect(id(key('b', 'KeyB', { metaKey: true }), true)).toBe('bold');
    expect(id(key('b', 'KeyB', { ctrlKey: true }), true)).toBe(null);
    expect(id(key('b', 'KeyB', { ctrlKey: true }), false)).toBe('bold');
    expect(id(key('b', 'KeyB', { metaKey: true }), false)).toBe(null);
  });
  it('reads shifted digits and minus by physical key', () => {
    expect(id(key('*', 'Digit8', { metaKey: true, shiftKey: true }), true)).toBe('bullet');
    expect(id(key('&', 'Digit7', { ctrlKey: true, shiftKey: true }), false)).toBe('number');
    expect(id(key('(', 'Digit9', { ctrlKey: true, shiftKey: true }), false)).toBe('quote');
    expect(id(key('_', 'Minus', { metaKey: true, shiftKey: true }), true)).toBe('rule');
    expect(id(key('C', 'KeyC', { metaKey: true, shiftKey: true }), true)).toBe('code');
    expect(id(key('X', 'KeyX', { ctrlKey: true, shiftKey: true }), false)).toBe('fence');
  });
  it('ignores Alt (AltGr), composition, and the shortcuts it does not own', () => {
    expect(id(key('b', 'KeyB', { ctrlKey: true, altKey: true }), false)).toBe(null);
    expect(id({ ...key('b', 'KeyB', { metaKey: true }), isComposing: true }, true)).toBe(null);
    expect(id({ ...key('b', 'KeyB', { metaKey: true }), keyCode: 229 }, true)).toBe(null);
    expect(id(key('e', 'KeyE', { metaKey: true }), true)).toBe(null);
    expect(id(key('m', 'KeyM', { metaKey: true }), true)).toBe(null);
    expect(id(key('k', 'KeyK', { metaKey: true }), true)).toBe(null);
    expect(id(key('b', 'KeyB', { metaKey: true, shiftKey: true }), true)).toBe(null);
  });
  it('follows the typed letter on other layouts', () => {
    expect(id(key('b', 'KeyN', { ctrlKey: true }), false)).toBe('bold'); // Dvorak-ish: b on another key
    expect(id(key('и', 'KeyB', { ctrlKey: true }), false)).toBe('bold'); // Cyrillic layout: physical B
  });
  it('labels keys with the platform modifiers', () => {
    const bullet = F.SHORTCUTS.find((s: { id: string }) => s.id === 'bullet');
    expect(F.keysFor(bullet, true)).toBe('⌘⇧8');
    expect(F.keysFor(bullet, false)).toBe('Ctrl+Shift+8');
  });
  it('turns a change into one minimal replacement', () => {
    expect(F.diff('say hello there', 'say **hello** there')).toEqual({ from: 4, to: 9, text: '**hello**' });
    expect(F.diff('a ****b', 'a b')).toEqual({ from: 2, to: 6, text: '' });
  });
});

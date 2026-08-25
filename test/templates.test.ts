import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TemplateStore } from '../server/templates.js';

const store = () => new TemplateStore(mkdtempSync(join(tmpdir(), 'x056-tpl-')));

describe('saving a template', () => {
  it('keeps the body verbatim — indentation and blank lines are usually the point', () => {
    const s = store();
    const body = 'Review this:\n\n  - correctness\n  - edge cases';
    expect(s.add({ name: 'review', body }).body).toBe(body);
  });

  it('strips a trailing newline, which would land the caret on an empty line', () => {
    const s = store();
    expect(s.add({ name: 'x', body: 'hello\n\n' }).body).toBe('hello');
  });

  it('refuses a template with no name or no body rather than storing a blank row', () => {
    const s = store();
    expect(() => s.add({ name: '  ', body: 'x' })).toThrow(/name/);
    expect(() => s.add({ name: 'x', body: '   \n ' })).toThrow(/body/);
  });

  it('collapses whitespace in the NAME only, so the picker lines up', () => {
    const s = store();
    expect(s.add({ name: '  bug   report ', body: 'x' }).name).toBe('bug report');
  });
});

describe('the picker order', () => {
  it('puts the ones actually used first', () => {
    const s = store();
    const a = s.add({ name: 'a', body: 'a' });
    const b = s.add({ name: 'b', body: 'b' });
    s.used(b.id);
    s.used(b.id);
    s.used(a.id);
    expect(s.list().map((t) => t.name)).toEqual(['b', 'a']);
  });

  it('breaks a tie by most recently updated, not insertion order', () => {
    const s = store();
    const a = s.add({ name: 'a', body: 'a' });
    s.add({ name: 'b', body: 'b' });
    s.update(a.id, { body: 'a2' });
    expect(s.list()[0].name).toBe('a');
  });
});

describe('editing and deleting', () => {
  it('updates one field without clearing the other', () => {
    const s = store();
    const t = s.add({ name: 'old', body: 'keep me' });
    expect(s.update(t.id, { name: 'new' })).toMatchObject({ name: 'new', body: 'keep me' });
  });

  it('reports an unknown id instead of silently doing nothing', () => {
    const s = store();
    expect(s.update('nope', { name: 'x' })).toBeNull();
    expect(s.remove('nope')).toBe(false);
    expect(s.used('nope')).toBeNull();
  });

  it('deletes only the one asked for', () => {
    const s = store();
    const a = s.add({ name: 'a', body: 'a' });
    s.add({ name: 'b', body: 'b' });
    expect(s.remove(a.id)).toBe(true);
    expect(s.list().map((t) => t.name)).toEqual(['b']);
  });
});

describe('persistence', () => {
  // The panel is used from a phone AND a desktop; templates live on the gateway
  // precisely so both see the same set, which only works if they survive a
  // restart.
  it('reloads what was saved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-tpl-'));
    const first = new TemplateStore(dir);
    first.add({ name: 'kept', body: 'across restarts' });
    expect(new TemplateStore(dir).list().map((t) => t.name)).toEqual(['kept']);
  });

  it('starts empty rather than throwing on a corrupt file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-tpl-'));
    const s = new TemplateStore(dir);
    s.add({ name: 'a', body: 'a' });
    writeFileSync(join(dir, 'templates.json'), '{ not json');
    expect(new TemplateStore(dir).list()).toEqual([]);
  });

  it('writes valid JSON on every mutation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-tpl-'));
    const s = new TemplateStore(dir);
    const t = s.add({ name: 'a', body: 'a' });
    s.update(t.id, { body: 'b' });
    s.used(t.id);
    const raw = JSON.parse(readFileSync(join(dir, 'templates.json'), 'utf8')) as { body: string; useCount: number }[];
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({ body: 'b', useCount: 1 });
  });
});

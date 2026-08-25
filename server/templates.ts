import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

/**
 * Saved prompt templates, inserted into the composer at the caret.
 *
 * Stored on the GATEWAY rather than in the browser: the panel is used from a
 * phone and a desktop, and localStorage would silently give each one its own
 * private set — a template written on the laptop simply would not exist on the
 * phone, with nothing in the UI to explain why.
 */

export const TEMPLATES = Symbol('x056-templates');

export interface PromptTemplate {
  id: string;
  name: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  /** Bumped on insert, so the picker can offer the ones actually used first. */
  useCount: number;
  lastUsedAt?: number;
}

const MAX_NAME = 80;
const MAX_BODY = 20_000;
const MAX_TEMPLATES = 200;

export class TemplateStore {
  private items: PromptTemplate[] = [];

  constructor(private readonly stateDir: string) { this.load(); }

  private get file(): string { return join(this.stateDir, 'templates.json'); }

  private load(): void {
    try { this.items = JSON.parse(readFileSync(this.file, 'utf8')) as PromptTemplate[]; } catch { this.items = []; }
    if (!Array.isArray(this.items)) this.items = [];
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    // Write-then-rename: the panel reads this file on every open, and a partial
    // write would present as "all my templates are gone".
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.items, null, 2));
    renameSync(tmp, this.file);
  }

  /** Most-used first, then most-recently-updated. */
  list(): PromptTemplate[] {
    return [...this.items]
      .sort((a, b) => (b.useCount - a.useCount) || (b.updatedAt - a.updatedAt))
      .map((t) => ({ ...t }));
  }

  private clean(name: string | undefined, body: string | undefined): { name: string; body: string } {
    const n = (name ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
    // The body keeps its whitespace — indentation and blank lines are usually
    // the point of a template — but not a trailing newline, which would push the
    // caret onto an empty line after every insert.
    const b = (body ?? '').replace(/\s+$/, '').slice(0, MAX_BODY);
    if (!n) throw new Error('a template needs a name');
    if (!b) throw new Error('a template needs a body');
    return { name: n, body: b };
  }

  add(input: { name?: string; body?: string }): PromptTemplate {
    if (this.items.length >= MAX_TEMPLATES) throw new Error(`at most ${MAX_TEMPLATES} templates`);
    const { name, body } = this.clean(input.name, input.body);
    const now = Date.now();
    const t: PromptTemplate = { id: randomUUID().slice(0, 8), name, body, createdAt: now, updatedAt: now, useCount: 0 };
    this.items.push(t);
    this.save();
    return { ...t };
  }

  update(id: string, patch: { name?: string; body?: string }): PromptTemplate | null {
    const t = this.items.find((x) => x.id === id);
    if (!t) return null;
    const { name, body } = this.clean(patch.name ?? t.name, patch.body ?? t.body);
    t.name = name;
    t.body = body;
    t.updatedAt = Date.now();
    this.save();
    return { ...t };
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((t) => t.id !== id);
    if (this.items.length === before) return false;
    this.save();
    return true;
  }

  /** Record an insertion. Never throws: a lost count must not fail the insert. */
  used(id: string): PromptTemplate | null {
    const t = this.items.find((x) => x.id === id);
    if (!t) return null;
    t.useCount += 1;
    t.lastUsedAt = Date.now();
    try { this.save(); } catch { /* ordering is a nicety, not worth an error */ }
    return { ...t };
  }
}

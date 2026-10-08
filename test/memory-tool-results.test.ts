import { describe, expect, it } from 'vitest';
// @ts-ignore shared JavaScript MCP helper
import { compactMemoryResult, MEMORY_RESULT_CHARS } from '../scripts/x056-mcp-memory-results.mjs';
const note = (id = 'note', content = 'x'.repeat(64000)) => ({ id, revision: 1, title: id, content,
  summary: '', tags: [], sharedProjectIds: [], sources: [{ id: 'source', label: 'Evidence', versionId: 'v1' }],
  status: 'confirmed', updatedAt: 1 });
describe('bounded memory tool results', () => {
  it('pages search results within one aggregate bound without losing ids', () => {
    const all = Array.from({ length: 100 }, (_, i) => note(String(i)));
    let offset = 0; const seen: string[] = [];
    while (offset < all.length) {
      const result = compactMemoryResult('memory_search', { items: all.slice(offset), offset, limit: 100, total: all.length });
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(MEMORY_RESULT_CHARS);
      expect(result.items.every((item: any) => item.contentTruncated)).toBe(true);
      expect(result.items[0].sources[0].versionId).toBe('v1');
      seen.push(...result.items.map((item: any) => item.id));
      offset = result.nextOffset ?? all.length;
    }
    expect(seen).toEqual(all.map(item => item.id));
  });
  it('paginates escaped body text exactly and never emits revision or source bodies', () => {
    const body = '\u0000"\\'.repeat(10000), original = note('note', body);
    const data = { entry: original, revisions: [note('note', 'SECRET REVISION')], related: [],
      sources: [{ label: 'Evidence', current: { id: 'source', content: 'SECRET SOURCE', title: 'File', hash: 'hash', projectId: 'p', kind: 'document' } }] };
    let offset = 0, rebuilt = '';
    while (offset < body.length) {
      const result = compactMemoryResult('memory_read', data, { offset });
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(MEMORY_RESULT_CHARS);
      expect(JSON.stringify(result)).not.toContain('SECRET');
      expect(result.totalCharacters).toBe(body.length);
      expect(result.entry.content.length).toBeGreaterThan(0);
      rebuilt += result.entry.content;
      offset = result.nextOffset ?? body.length;
    }
    expect(rebuilt).toBe(body);
    expect(data.entry.content).toBe(body);
    expect(data.revisions[0].content).toBe('SECRET REVISION');
  });
  it('bounds source search with complete cited passages and a continuation', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ id: String(i), text: 'a'.repeat(1800), citation: { sourceId: 'source', versionId: 'v1', passageId: String(i) } }));
    const result = compactMemoryResult('memory_source_search', { items, total: 20 }, { offset: 0 });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(MEMORY_RESULT_CHARS);
    expect(result.nextOffset).toBe(result.items.length);
    expect(result.truncated).toBe(true);
    expect(result.items).toEqual(items.slice(0, result.items.length));
  });
  it('fails explicitly when one passage cannot fit rather than repeating an offset', () => {
    expect(() => compactMemoryResult('memory_source_search', { items: [{ text: 'x'.repeat(13000) }], total: 1 }))
      .toThrow('exceeds the response budget');
  });
  it('reports metadata omissions while keeping the original source references unchanged', () => {
    const original = note();
    original.sources = Array.from({ length: 30 }, (_, i) => ({ id: String(i), label: 'Evidence', versionId: 'v1' }));
    const result = compactMemoryResult('memory_read', { entry: original, revisions: Array.from({ length: 30 }, () => original), sources: [], related: [] });
    expect(result.metadataTruncated).toBe(true);
    expect(result.revisionsTotal).toBe(30);
    expect(result.revisions.length).toBeLessThan(30);
    expect(result.entry.sources).toEqual(original.sources.slice(0, 3));
    expect(original.sources).toHaveLength(30);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(MEMORY_RESULT_CHARS);
  });
  it('leaves mutation results untouched', () => {
    const data = note();
    expect(compactMemoryResult('memory_update', data)).toBe(data);
  });
});

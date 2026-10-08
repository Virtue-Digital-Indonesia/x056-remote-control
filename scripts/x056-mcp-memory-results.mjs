// Tool-only projections. Library HTTP responses and stored evidence remain complete.
export const MEMORY_RESULT_CHARS = 12000;
const size = value => JSON.stringify(value).length;
const integer = (value, fallback) => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : fallback;
const pick = (value, keys) => Object.fromEntries(keys.filter(k => value?.[k] !== undefined).map(k => [k, value[k]]));
const revision = value => pick(value, ['id', 'revision', 'title', 'updatedAt', 'status']);
const source = value => pick(value, ['id', 'versionId', 'title', 'kind', 'projectId', 'sessionId', 'spaceId', 'hash', 'ref']);
function entry(value, content) {
  const result = { ...value, content, summary: (value.summary || '').slice(0, 300),
    tags: (value.tags || []).slice(0, 8), sharedProjectIds: (value.sharedProjectIds || []).slice(0, 8),
    sources: (value.sources || []).slice(0, 3), contentTruncated: content.length < value.content.length };
  result.metadataTruncated = result.summary !== value.summary || result.tags.length !== value.tags?.length ||
    result.sharedProjectIds.length !== value.sharedProjectIds?.length || result.sources.length !== value.sources?.length;
  return result;
}
function trimEntryMetadata(value) {
  for (const key of ['sources', 'tags', 'sharedProjectIds']) {
    if (value[key]?.length) { value[key].pop(); value.metadataTruncated = true; return true; }
  }
  if (value.summary) { value.summary = ''; value.metadataTruncated = true; return true; }
  return false;
}
function page(name, data, args) {
  const offset = integer(data.offset ?? args.offset, 0), limit = Math.max(1, Math.min(name === 'memory_source_read' ? 5 : name === 'memory_search' ? 100 : 200, integer(data.limit ?? args.limit, 20)));
  const result = { ...data, items: [], offset, limit, truncated: false };
  for (const original of data.items || []) {
    const item = name === 'memory_search' ? entry(original, original.content.slice(0, 600)) : original;
    // Keep a large first note discoverable without allowing metadata to defeat the cap.
    while (name === 'memory_search' && size({ ...result, items: [...result.items, item] }) > MEMORY_RESULT_CHARS - 100 && trimEntryMetadata(item)) {}
    if (size({ ...result, items: [...result.items, item] }) > MEMORY_RESULT_CHARS - 100) break;
    result.items.push(item);
  }
  if (!result.items.length && data.items?.length) throw new Error('A memory result exceeds the response budget. Read a smaller note page or download the cited source file.');
  if (offset + result.items.length < data.total) result.nextOffset = offset + result.items.length;
  result.truncated = result.nextOffset !== undefined || result.items.some(i => i.contentTruncated || i.metadataTruncated);
  return result;
}
export function compactMemoryResult(name, data, args = {}) {
  if (['memory_search', 'memory_source_search', 'memory_source_read'].includes(name)) return page(name, data, args);
  if (name !== 'memory_read') return data;
  const offset = Math.min(integer(args.offset, 0), data.entry.content.length), limit = Math.max(1, Math.min(8000, integer(args.limit, 8000)));
  const result = { entry: entry(data.entry, data.entry.content.slice(offset, offset + limit)),
    revisions: (data.revisions || []).slice(0, 10).map(revision),
    related: (data.related || []).slice(0, 10).map(link => ({ ...link, ...(link.entry ? { entry: revision(link.entry) } : {}) })),
    sources: (data.sources || []).slice(0, 10).map(({ current, original, ...ref }) => ({ ...ref, ...(current ? { current: source(current) } : {}), ...(original ? { original: source(original) } : {}) })),
    offset, limit, totalCharacters: data.entry.content.length, revisionsTotal: (data.revisions || []).length,
    relatedTotal: (data.related || []).length, sourcesTotal: (data.sources || []).length,
    metadataTruncated: false, truncated: false };
  result.metadataTruncated = result.entry.metadataTruncated || result.revisions.length < result.revisionsTotal || result.related.length < result.relatedTotal || result.sources.length < result.sourcesTotal;
  while (size(result) > MEMORY_RESULT_CHARS - 100) {
    const list = [result.related, result.sources, result.revisions].find(items => items.length);
    if (list) { list.pop(); result.metadataTruncated = true; continue; }
    if (trimEntryMetadata(result.entry)) { result.metadataTruncated = true; continue; }
    // JSON escaping can expand content by up to six times. Reduce using serialized size.
    result.entry.content = result.entry.content.slice(0, Math.max(0, result.entry.content.length - Math.max(1, Math.ceil((size(result) - MEMORY_RESULT_CHARS + 100) / 6))));
    if (!result.entry.content) break;
  }
  const next = offset + result.entry.content.length;
  if (next < result.totalCharacters) result.nextOffset = next;
  result.entry.contentTruncated = offset > 0 || next < result.totalCharacters;
  result.truncated = result.entry.contentTruncated || result.metadataTruncated;
  return result;
}

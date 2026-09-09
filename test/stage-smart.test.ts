import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const code = readFileSync('design/panel-release/control-room.js', 'utf8');
const candidateFunction = code.slice(
  code.indexOf('  function stageCandidates('),
  code.indexOf('  function stageKey('),
);
const chat = (n: number, status = 'idle', unread = false) => ({
  k: 'p::' + n,
  p: { id: 'p' },
  c: { sessionId: String(n) },
  status,
  unread,
  time: n,
});
function select(all: ReturnType<typeof chat>[], options: Record<string, unknown> = {}) {
  return runInNewContext(candidateFunction + '\nstageCandidates(all)', {
    all,
    stageMode: 'smart',
    stagePins: [],
    stageRecent: [],
    recentDismissed: [],
    stageDismissed: [],
    dismissedProjects: [],
    conversationMeta: {},
    stageKey: (p: string, s: string) => p + '::' + s,
    ...options,
  }) as ReturnType<typeof chat>[];
}
describe('smart desktop conversation switcher', () => {
  it('prioritizes pins, questions, unread replies and running work without filling with idle history', () => {
    const rows = [chat(1), chat(2, 'running'), chat(3, 'finished', true), chat(4, 'question'), chat(5)];
    expect(select(rows, { stagePins: ['p::1'], stageRecent: ['p::5'] }).map((x) => x.k)).toEqual([
      'p::1',
      'p::4',
      'p::3',
      'p::2',
      'p::5',
    ]);
  });
  it('caps automatic suggestions while preserving last-opened and all explicit pins', () => {
    const rows = Array.from({ length: 30 }, (_, i) => chat(i, 'running'));
    expect(select(rows, { stageRecent: ['p::0'] })).toHaveLength(8);
    expect(select(rows, { stageRecent: ['p::0'] }).some((x) => x.k === 'p::0')).toBe(true);
    const pins = rows.slice(0, 12).map((x) => x.k);
    expect(select(rows, { stagePins: pins }).map((x) => x.k)).toEqual(pins);
  });
  it('honors dismissals and archived projects but retains deliberate pins', () => {
    const rows = [chat(1, 'question'), chat(2, 'finished', true), chat(3, 'running')];
    expect(
      select(rows, { stageDismissed: ['p::1'], conversationMeta: { 'p::2': { archived: true } } }).map(
        (x) => x.k,
      ),
    ).toEqual(['p::3']);
    expect(select(rows, { dismissedProjects: ['p'] })).toHaveLength(0);
    expect(select(rows, { dismissedProjects: ['p'], stagePins: ['p::2'] }).map((x) => x.k)).toEqual(['p::2']);
  });
  it('limits quiet recent suggestions and leaves pinned-only and recent modes intact', () => {
    const rows = Array.from({ length: 30 }, (_, i) => chat(i)),
      recent = rows.map((x) => x.k);
    expect(
      select(rows, { stageRecent: recent })
        .map((x) => x.k)
        .sort(),
    ).toEqual(['p::0', 'p::1', 'p::2']);
    expect(select(rows, { stageMode: 'pinned', stagePins: ['p::20'] }).map((x) => x.k)).toEqual(['p::20']);
    expect(
      select(rows, { stageMode: 'recent', stageRecent: recent, stageDismissed: ['p::0'] }),
    ).toHaveLength(29);
  });
});

import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearTranscriptCache, findTranscript, uniqueProjectsDirs } from '../src/adapters/claude.js';

const cfg = () => mkdtempSync(join(tmpdir(), 'x056-ft-'));
const write = (dir: string, project: string, sid: string) => {
  mkdirSync(join(dir, 'projects', project), { recursive: true });
  const f = join(dir, 'projects', project, `${sid}.jsonl`);
  writeFileSync(f, '{}\n');
  return f;
};

describe('findTranscript cache', () => {
  beforeEach(() => clearTranscriptCache());

  it('finds a transcript two levels down and skips subagent transcripts', () => {
    const a = cfg();
    const f = write(a, '-proj', 's1');
    mkdirSync(join(a, 'projects', '-proj', 's1', 'subagents'), { recursive: true });
    writeFileSync(join(a, 'projects', '-proj', 's1', 'subagents', 'agent-x.jsonl'), '{}\n');
    expect(findTranscript([a], 's1')).toBe(f);
    expect(findTranscript([a], 'agent-x')).toBeNull();
  });

  // Root ignores the mode bits the test relies on.
  it.skipIf(process.getuid?.() === 0)('serves a hit from the cache without listing the tree again', () => {
    const a = cfg();
    const f = write(a, '-proj', 's1');
    expect(findTranscript([a], 's1')).toBe(f);
    // Take away read permission on projects/: a fresh look-up could no longer
    // list it, but a cached path is still reachable (execute bit kept).
    chmodSync(join(a, 'projects'), 0o100);
    try {
      expect(findTranscript([a], 's1')).toBe(f);
      clearTranscriptCache();
      expect(findTranscript([a], 's1')).toBeNull();
    } finally { chmodSync(join(a, 'projects'), 0o755); }
  });

  it('drops a cached path that no longer exists and looks it up again', () => {
    const a = cfg();
    const f = write(a, '-old', 's1');
    expect(findTranscript([a], 's1')).toBe(f);
    mkdirSync(join(a, 'projects', '-new'), { recursive: true });
    const moved = join(a, 'projects', '-new', 's1.jsonl');
    renameSync(f, moved);
    expect(findTranscript([a], 's1')).toBe(moved);
    rmSync(moved);
    expect(findTranscript([a], 's1')).toBeNull();
  });

  it('does not cache a miss: a transcript written later is found', () => {
    const a = cfg();
    mkdirSync(join(a, 'projects', '-proj'), { recursive: true });
    expect(findTranscript([a], 'later')).toBeNull();
    const f = write(a, '-proj', 'later');
    expect(findTranscript([a], 'later')).toBe(f);
  });

  it('keys on the config dirs, so the same sid in another tree is not confused', () => {
    const a = cfg(), b = cfg();
    const fa = write(a, '-a', 'same');
    const fb = write(b, '-b', 'same');
    expect(findTranscript([a], 'same')).toBe(fa);
    expect(findTranscript([b], 'same')).toBe(fb);
    expect(findTranscript([b, a], 'same')).toBe(fb);
  });

  it('walks a shared projects/ tree once, keeping the first config dir path', () => {
    const shared = cfg(), a = cfg(), b = cfg();
    mkdirSync(join(shared, 'projects'));
    symlinkSync(join(shared, 'projects'), join(a, 'projects'));
    symlinkSync(join(shared, 'projects'), join(b, 'projects'));
    const missing = cfg();
    expect(uniqueProjectsDirs([missing, a, b, shared])).toEqual([join(a, 'projects')]);
    write(shared, '-p', 's');
    expect(findTranscript([b, a], 's')).toBe(join(b, 'projects', '-p', 's.jsonl'));
  });
});

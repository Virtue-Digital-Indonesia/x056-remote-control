import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CronScheduler, cronMatches, parseCron, wallClock } from '../server/cron.js';

const at = (iso: string) => new Date(iso);
const matches = (expr: string, iso: string, tz = 'UTC') => cronMatches(parseCron(expr), at(iso), tz);

function scheduler(deliver?: CronSchedulerDeliver) {
  const stateDir = mkdtempSync(join(tmpdir(), 'x056-cron-'));
  const sent: { projectId: string; sessionId?: string; prompt: string }[] = [];
  const fn = deliver ?? ((projectId: string, sessionId: string | undefined, prompt: string) => {
    sent.push({ projectId, sessionId, prompt });
    return { sessionId: sessionId ?? 'new-sess', queued: false };
  });
  return { s: new CronScheduler({ stateDir, deliver: fn, defaultTz: 'Asia/Jakarta' }), sent, stateDir };
}
type CronSchedulerDeliver = (p: string, s: string | undefined, m: string) => { sessionId: string; queued: boolean };

describe('cron expression parsing', () => {
  it('rejects anything that is not five fields, before storing a job', () => {
    expect(() => parseCron('* * * *')).toThrow(/5 fields/);
    expect(() => parseCron('')).toThrow(/5 fields/);
    expect(() => parseCron('* * * * * *')).toThrow(/5 fields/);
  });

  it('rejects out-of-range values rather than silently never firing', () => {
    expect(() => parseCron('99 * * * *')).toThrow(/0-59/);
    expect(() => parseCron('* 25 * * *')).toThrow(/0-23/);
    expect(() => parseCron('* * 32 * *')).toThrow(/1-31/);
  });

  it('handles lists, ranges and steps', () => {
    expect(matches('0,30 * * * *', '2026-08-24T10:30:00Z')).toBe(true);
    expect(matches('0,30 * * * *', '2026-08-24T10:15:00Z')).toBe(false);
    expect(matches('*/15 * * * *', '2026-08-24T10:45:00Z')).toBe(true);
    expect(matches('*/15 * * * *', '2026-08-24T10:46:00Z')).toBe(false);
    expect(matches('0 9-17 * * *', '2026-08-24T09:00:00Z')).toBe(true);
    expect(matches('0 9-17 * * *', '2026-08-24T18:00:00Z')).toBe(false);
  });

  it('treats 7 and 0 as Sunday, as every other cron does', () => {
    expect(matches('0 9 * * 0', '2026-08-23T09:00:00Z')).toBe(true); // a Sunday
    expect(matches('0 9 * * 7', '2026-08-23T09:00:00Z')).toBe(true);
  });

  it('ORs day-of-month with day-of-week when BOTH are restricted — the standard quirk', () => {
    // 2026-08-24 is a Monday and not the 1st.
    expect(matches('0 9 1 * 1', '2026-08-24T09:00:00Z')).toBe(true);  // matches by weekday
    expect(matches('0 9 1 * 3', '2026-08-24T09:00:00Z')).toBe(false); // neither
  });

  it('ANDs normally when only one day field is restricted', () => {
    expect(matches('0 9 24 * *', '2026-08-24T09:00:00Z')).toBe(true);
    expect(matches('0 9 25 * *', '2026-08-24T09:00:00Z')).toBe(false);
  });
});

describe('timezone — the thing that would silently fire seven hours early', () => {
  it('reads the wall clock in the job\'s zone, not the container\'s UTC', () => {
    // 02:00 UTC is 09:00 in Jakarta (UTC+7).
    expect(wallClock(at('2026-08-24T02:00:00Z'), 'Asia/Jakarta').hour).toBe(9);
    expect(wallClock(at('2026-08-24T02:00:00Z'), 'UTC').hour).toBe(2);
  });

  it('fires "0 9 * * *" at 9am Jakarta, not 9am UTC', () => {
    expect(matches('0 9 * * *', '2026-08-24T02:00:00Z', 'Asia/Jakarta')).toBe(true);
    expect(matches('0 9 * * *', '2026-08-24T09:00:00Z', 'Asia/Jakarta')).toBe(false);
  });

  it('rolls the date over correctly near midnight in the target zone', () => {
    // 17:00 UTC Sunday is Monday 00:00 in Jakarta.
    const t = wallClock(at('2026-08-23T17:00:00Z'), 'Asia/Jakarta');
    expect(t.hour).toBe(0);
    expect(t.dom).toBe(24);
    expect(t.dow).toBe(1); // Monday
    expect(matches('0 0 * * 1', '2026-08-23T17:00:00Z', 'Asia/Jakarta')).toBe(true);
  });
});

describe('scheduler', () => {
  it('defaults to the operator\'s zone, not UTC, when a job names none', () => {
    const { s } = scheduler();
    const job = s.add({ schedule: '0 9 * * *', projectId: 'p1', prompt: 'standup' });
    expect(job.tz).toBe('Asia/Jakarta');
  });

  it('refuses a bad schedule or unknown zone before storing anything', () => {
    const { s } = scheduler();
    expect(() => s.add({ schedule: 'nonsense', projectId: 'p1', prompt: 'x' })).toThrow(/5 fields/);
    expect(() => s.add({ schedule: '0 9 * * *', projectId: 'p1', prompt: 'x', tz: 'Mars/Olympus' })).toThrow(/unknown timezone/);
    expect(() => s.add({ schedule: '0 9 * * *', projectId: '', prompt: 'x' })).toThrow(/projectId/);
    expect(() => s.add({ schedule: '0 9 * * *', projectId: 'p1', prompt: '  ' })).toThrow(/prompt/);
    expect(s.list()).toEqual([]);
  });

  it('delivers a matching job and records the outcome', () => {
    const { s, sent } = scheduler();
    s.add({ schedule: '0 9 * * *', projectId: 'p1', sessionId: 's1', prompt: 'standup', tz: 'UTC' });
    const ran = s.tick(at('2026-08-24T09:00:00Z'));
    expect(ran).toHaveLength(1);
    expect(sent).toEqual([{ projectId: 'p1', sessionId: 's1', prompt: 'standup' }]);
    expect(s.list()[0].lastResult).toBe('delivered');
    expect(s.list()[0].runCount).toBe(1);
  });

  it('does not fire twice in the same minute, however often it ticks', () => {
    const { s, sent } = scheduler();
    s.add({ schedule: '* * * * *', projectId: 'p1', sessionId: 's1', prompt: 'x', tz: 'UTC' });
    s.tick(at('2026-08-24T09:00:00Z'));
    s.tick(at('2026-08-24T09:00:20Z'));
    s.tick(at('2026-08-24T09:00:40Z'));
    expect(sent).toHaveLength(1);
    s.tick(at('2026-08-24T09:01:00Z'));
    expect(sent).toHaveLength(2);
  });

  it('skips a paused job but keeps it', () => {
    const { s, sent } = scheduler();
    const job = s.add({ schedule: '* * * * *', projectId: 'p1', sessionId: 's1', prompt: 'x', tz: 'UTC' });
    s.setEnabled(job.id, false);
    s.tick(at('2026-08-24T09:00:00Z'));
    expect(sent).toHaveLength(0);
    expect(s.list()).toHaveLength(1);

    s.setEnabled(job.id, true);
    s.tick(at('2026-08-24T09:05:00Z'));
    expect(sent).toHaveLength(1);
  });

  it('binds a session-less job to the conversation it created, so it does not litter new ones', () => {
    const { s } = scheduler();
    s.add({ schedule: '* * * * *', projectId: 'p1', prompt: 'x', tz: 'UTC' });
    s.tick(at('2026-08-24T09:00:00Z'));
    expect(s.list()[0].sessionId).toBe('new-sess');
  });

  it('records a queued delivery distinctly from a delivered one', () => {
    const { s } = scheduler(() => ({ sessionId: 's1', queued: true }));
    s.add({ schedule: '* * * * *', projectId: 'p1', sessionId: 's1', prompt: 'x', tz: 'UTC' });
    s.tick(at('2026-08-24T09:00:00Z'));
    expect(s.list()[0].lastResult).toBe('queued');
  });

  it('keeps running the other jobs when one throws', () => {
    const { s } = scheduler((p) => {
      if (p === 'bad') throw new Error('boom');
      return { sessionId: 's', queued: false };
    });
    s.add({ schedule: '* * * * *', projectId: 'bad', sessionId: 's1', prompt: 'x', tz: 'UTC' });
    s.add({ schedule: '* * * * *', projectId: 'good', sessionId: 's2', prompt: 'y', tz: 'UTC' });
    const ran = s.tick(at('2026-08-24T09:00:00Z'));
    expect(ran).toHaveLength(2);
    expect(s.list().find((j) => j.projectId === 'bad')?.lastResult).toMatch(/failed: boom/);
    expect(s.list().find((j) => j.projectId === 'good')?.lastResult).toBe('delivered');
  });

  it('skips a job whose stored schedule is corrupt instead of dying on it', () => {
    const { s, sent } = scheduler();
    s.add({ schedule: '* * * * *', projectId: 'p1', sessionId: 's1', prompt: 'ok', tz: 'UTC' });
    (s as unknown as { jobs: { schedule: string }[] }).jobs.unshift({ schedule: 'garbage' } as never);
    expect(() => s.tick(at('2026-08-24T09:00:00Z'))).not.toThrow();
    expect(sent).toHaveLength(1);
  });

  it('survives a restart — jobs are on disk, not in memory', () => {
    const { s, stateDir } = scheduler();
    s.add({ schedule: '0 9 * * *', projectId: 'p1', prompt: 'standup', label: 'daily' });
    const reloaded = new CronScheduler({ stateDir, deliver: () => ({ sessionId: 's', queued: false }) });
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0].label).toBe('daily');
    expect(JSON.parse(readFileSync(join(stateDir, 'cron.json'), 'utf8'))).toHaveLength(1);
  });

  it('removes a job by id', () => {
    const { s } = scheduler();
    const job = s.add({ schedule: '0 9 * * *', projectId: 'p1', prompt: 'x' });
    expect(s.remove(job.id)).toBe(true);
    expect(s.remove(job.id)).toBe(false);
    expect(s.list()).toEqual([]);
  });
});

describe('panel wiring', () => {
  const html = readFileSync('server/public/panel.html', 'utf8');

  // Regression: hidePops() used a hand-maintained list of ids, so a newly-added
  // popover was never hidden — the backdrop vanished and left it stuck open.
  it('hides every .pop by enumeration, not a list that can go stale', () => {
    expect(html).toContain("document.querySelectorAll('.pop')");
    expect(html).not.toMatch(/function hidePops\(\) \{ quotaPop\.hidden/);
  });

  it('gives scheduled tasks its own icon, not the one "Resume a session" uses', () => {
    expect(html).toContain('id="i-alarm"');
    expect(html).toContain('id="cronBtn" title="Scheduled tasks"><svg class="ic"><use href="#i-alarm"/>');
    expect(html).toContain("{ id: 'cronBtn', label: 'Scheduled tasks', icon: 'alarm' }");
  });

  it('confirms a delete through the in-app modal, since native confirm() was replaced', () => {
    const del = html.slice(html.indexOf("del.addEventListener"), html.indexOf("del.addEventListener") + 700);
    expect(del).toContain('uiConfirm(');
    expect(del).not.toMatch(/\bif \(!confirm\(/);
  });
});

describe('one-shot jobs', () => {
  // "deploy at 3am tonight" written as plain cron is a job that fires EVERY
  // night, and the surprise arrives a day after everyone stopped thinking about
  // it. `once` is what makes the schedule mean the next match and no more.
  const add = (s: CronScheduler, once: boolean) =>
    s.add({ schedule: '0 3 * * *', projectId: 'p1', sessionId: 'c1', prompt: 'deploy', tz: 'Asia/Jakarta', once });

  it('runs at the next match and then deletes itself', () => {
    const { s, sent } = scheduler();
    add(s, true);
    s.tick(at('2026-08-25T20:00:00Z')); // 03:00 Jakarta
    expect(sent.map((x) => x.prompt)).toEqual(['deploy']);
    expect(s.list()).toEqual([]); // gone — not merely paused
  });

  it('does not fire again the next night, which is the whole point', () => {
    const { s, sent } = scheduler();
    add(s, true);
    s.tick(at('2026-08-25T20:00:00Z'));
    s.tick(at('2026-08-26T20:00:00Z'));
    expect(sent.length).toBe(1);
  });

  it('leaves a repeating job alone — `once` is opt-in', () => {
    const { s, sent } = scheduler();
    add(s, false);
    s.tick(at('2026-08-25T20:00:00Z'));
    s.tick(at('2026-08-26T20:00:00Z'));
    expect(sent.length).toBe(2);
    expect(s.list().length).toBe(1);
  });

  it('survives a restart still marked one-shot', () => {
    const { s, stateDir } = scheduler();
    add(s, true);
    const reloaded = new CronScheduler({ stateDir, deliver: () => ({ sessionId: 'c1', queued: false }), defaultTz: 'Asia/Jakarta' });
    expect(reloaded.list()[0].once).toBe(true);
  });

  it('disables rather than deletes a one-shot whose delivery FAILED', () => {
    // Deleting would hide why it never ran; leaving it armed would fire it at
    // the next match — a full day later, unattended.
    const { s } = scheduler(() => { throw new Error('conversation is gone'); });
    add(s, true);
    s.tick(at('2026-08-25T20:00:00Z'));
    const [job] = s.list();
    expect(job).toBeTruthy();
    expect(job.enabled).toBe(false);
    expect(job.lastResult).toMatch(/conversation is gone/);
  });

  it('reports itself as one-shot so the panel can say so', () => {
    const { s } = scheduler();
    expect(add(s, true).once).toBe(true);
    expect(add(s, false).once).toBeUndefined();
  });
});

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpServerManager } from '../server/mcp-servers.js';

const STUB = new URL('./bin/stub-mcp-cli', import.meta.url).pathname;

function accounts(root: string, names: string[]): { name: string; configDir: string }[] {
  return names.map((n) => {
    const dir = join(root, n);
    mkdirSync(dir, { recursive: true });
    return { name: n, configDir: dir };
  });
}

function mgr(claude: { name: string; configDir: string }[], codex: { name: string; configDir: string }[] = [], logFile?: string): McpServerManager {
  if (logFile) process.env.STUB_LOG = logFile; else delete process.env.STUB_LOG;
  process.env.STUB_MCP_PROVIDER = 'claude'; // per-call override below for codex
  return new McpServerManager({
    claudePath: STUB,
    codexPath: STUB,
    accounts: (p) => (p === 'codex' ? codex : claude),
    timeoutMs: 10_000,
  });
}

afterEach(() => { delete process.env.STUB_LOG; delete process.env.STUB_MCP_PROVIDER; });

const STDIO = { name: 'github', transport: 'stdio' as const, command: 'npx', args: ['-y', 'server-github'], env: { TOKEN: 'x' } };

describe('McpServerManager', () => {
  it('adds a server to EVERY claude account, each with its own CLAUDE_CONFIG_DIR', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x056-mcpsrv-'));
    const cl = accounts(root, ['a', 'b']);
    const log = join(root, 'log.jsonl');
    const res = await mgr(cl, [], log).add('claude', STDIO);
    expect(res.ok).toBe(true);
    expect(res.perDir.map((p) => p.account).sort()).toEqual(['a', 'b']);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(calls.every((c) => c.argv[0] === 'mcp' && c.argv[1] === 'add-json')).toBe(true);
    expect(calls.map((c) => c.cfg).sort()).toEqual(cl.map((d) => d.configDir).sort());
    // scoped to the user config, and the JSON carries the whole definition
    expect(calls[0].argv).toContain('-s');
    expect(calls[0].argv).toContain('user');
    expect(JSON.parse(calls[0].argv[3])).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'server-github'], env: { TOKEN: 'x' } });
  });

  it('lists servers aggregated across accounts, flagging one that is missing somewhere', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x056-mcpsrv2-'));
    const cl = accounts(root, ['a', 'b']);
    await mgr(cl).add('claude', STDIO);
    // now a server only account "a" has (drift — it would vanish on failover)
    writeFileSync(join(cl[0].configDir, '.claude.json'), JSON.stringify({
      mcpServers: {
        github: { type: 'stdio', command: 'npx', args: ['-y', 'server-github'], env: { TOKEN: 'x' } },
        lonely: { type: 'http', url: 'https://only-a.example/mcp' },
      },
    }));
    const { servers } = await mgr(cl).list();
    const gh = servers.find((s) => s.name === 'github')!;
    const lonely = servers.find((s) => s.name === 'lonely')!;
    expect({ n: gh.accountCount, t: gh.totalAccounts, synced: gh.synced }).toEqual({ n: 2, t: 2, synced: true });
    expect({ n: lonely.accountCount, synced: lonely.synced }).toEqual({ n: 1, synced: false });
    expect(lonely.transport).toBe('http');
    expect(lonely.url).toBe('https://only-a.example/mcp');
  });

  it('flags a server DEFINED DIFFERENTLY on one account (same name, other command)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x056-mcpsrv3-'));
    const cl = accounts(root, ['a', 'b']);
    writeFileSync(join(cl[0].configDir, '.claude.json'), JSON.stringify({ mcpServers: { g: { type: 'stdio', command: 'npx', args: ['one'] } } }));
    writeFileSync(join(cl[1].configDir, '.claude.json'), JSON.stringify({ mcpServers: { g: { type: 'stdio', command: 'npx', args: ['TWO'] } } }));
    const { servers } = await mgr(cl).list();
    const g = servers.find((s) => s.name === 'g')!;
    expect(g.accountCount).toBe(2);
    expect(g.synced).toBe(false);      // present everywhere but not identical
    expect(g.differing).toEqual(['b']);
  });

  it('update() replaces the definition even though the CLI refuses to overwrite', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x056-mcpsrv4-'));
    const cl = accounts(root, ['a']);
    const m = mgr(cl);
    await m.add('claude', STDIO);
    const changed = { ...STDIO, args: ['-y', 'server-github@2'], env: { TOKEN: 'new' } };
    const res = await m.update('claude', changed);
    expect(res.ok).toBe(true);
    const stored = JSON.parse(readFileSync(join(cl[0].configDir, '.claude.json'), 'utf8')).mcpServers.github;
    expect(stored).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'server-github@2'], env: { TOKEN: 'new' } });
  });

  it('removes from every account', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x056-mcpsrv5-'));
    const cl = accounts(root, ['a', 'b']);
    const m = mgr(cl);
    await m.add('claude', STDIO);
    expect((await m.list()).servers.length).toBe(1);
    const res = await m.remove('claude', 'github');
    expect(res.ok).toBe(true);
    expect((await m.list()).servers.length).toBe(0);
  });

  it('builds codex argv in its own shape (--env before --, url form for http)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x056-mcpsrv6-'));
    const cx = accounts(root, ['d']);
    const log = join(root, 'log.jsonl');
    process.env.STUB_MCP_PROVIDER = 'codex';
    const m = new McpServerManager({ claudePath: STUB, codexPath: STUB, accounts: (p) => (p === 'codex' ? cx : []), timeoutMs: 10_000 });
    process.env.STUB_LOG = log;
    await m.add('codex', STDIO);
    await m.add('codex', { name: 'api', transport: 'http', url: 'https://x.example/mcp' });
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const stdio = calls.find((c) => c.argv[2] === 'github')!.argv;
    expect(stdio.slice(0, 3)).toEqual(['mcp', 'add', 'github']);
    expect(stdio).toContain('--env');
    expect(stdio[stdio.indexOf('--env') + 1]).toBe('TOKEN=x');
    // the server's own command line comes after `--`
    const dd = stdio.indexOf('--');
    expect(stdio.slice(dd + 1)).toEqual(['npx', '-y', 'server-github']);
    const http = calls.find((c) => c.argv[2] === 'api')!.argv;
    expect(http).toEqual(['mcp', 'add', 'api', '--url', 'https://x.example/mcp']);
    // and reading back goes through `list --json`
    const { servers } = await m.list();
    expect(servers.map((s) => s.name).sort()).toEqual(['api', 'github']);
    expect(servers.find((s) => s.name === 'github')!.provider).toBe('codex');
  });

  it('reports a partial failure rather than claiming success', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x056-mcpsrv7-'));
    const cl = accounts(root, ['a', 'b']);
    const m = mgr(cl);
    await m.add('claude', STDIO);
    // 'a' already has it → the CLI refuses (exit 1); 'b' is clean → succeeds
    writeFileSync(join(cl[1].configDir, '.claude.json'), JSON.stringify({ mcpServers: {} }));
    const res = await m.add('claude', STDIO);
    expect(res.ok).toBe(false);
    expect(res.perDir.find((p) => p.account === 'a')!.ok).toBe(false);
    expect(res.perDir.find((p) => p.account === 'b')!.ok).toBe(true);
  });

  it('returns ok:false with no accounts rather than silently succeeding', async () => {
    const m = new McpServerManager({ claudePath: STUB, accounts: () => [], timeoutMs: 5_000 });
    expect(await m.add('claude', STDIO)).toEqual({ ok: false, perDir: [] });
  });
});

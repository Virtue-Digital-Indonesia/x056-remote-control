import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AccountRegistry } from '../src/accounts.js';
import type { ProviderId } from '../src/provider.js';

/** A provider-neutral MCP server definition, as the panel edits it. Maps onto
 *  each CLI's own flags/JSON in addArgs() below. */
export interface McpServerSpec {
  name: string;
  transport: 'stdio' | 'http';
  /** stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http */
  url?: string;
  headers?: Record<string, string>;
}

/** One configured server, aggregated across every account of its provider. */
export interface McpServerInfo extends McpServerSpec {
  provider: ProviderId;
  /** Accounts that have it, out of that provider's total. */
  accountCount: number;
  totalAccounts: number;
  /** Present on every account — the only state that survives a failover. */
  synced: boolean;
  /** Accounts whose definition differs from the one shown (drift). */
  differing: string[];
}

export interface McpOpResult {
  ok: boolean;
  perDir: { account: string; ok: boolean; message: string }[];
}

export interface McpServerManagerOptions {
  claudePath?: string;
  codexPath?: string;
  /** Re-read per call so adding/removing an account is picked up without a restart. */
  accounts: (provider: ProviderId) => { name: string; configDir: string }[];
  timeoutMs?: number;
}

/**
 * Manages MCP servers across the failover accounts, per provider. Every mutation
 * is replicated to ALL of that provider's accounts, because a turn can run on
 * any of them — a server configured on only one silently disappears the moment
 * the session fails over.
 *
 * Reads and writes go through each CLI's own `mcp` subcommand rather than
 * editing its config by hand, except for Claude's list: `claude mcp list`
 * health-checks every server (slow, and fails when one is down), while the
 * user-scoped servers it would print are plainly readable from .claude.json.
 */
export class McpServerManager {
  private readonly timeoutMs: number;
  constructor(private readonly opts: McpServerManagerOptions) {
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  static accountsFromRegistry(accountsFile: string): (provider: ProviderId) => { name: string; configDir: string }[] {
    return (provider) => {
      try {
        return AccountRegistry.load(accountsFile)
          .list()
          .filter((a) => a.provider === provider)
          .map((a) => ({ name: a.name, configDir: a.configDir }));
      } catch {
        return [];
      }
    };
  }

  private bin(provider: ProviderId): string {
    return provider === 'codex' ? (this.opts.codexPath ?? 'codex') : (this.opts.claudePath ?? 'claude');
  }

  private run(provider: ProviderId, configDir: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    const env = provider === 'codex'
      ? { ...process.env, CODEX_HOME: configDir }
      : { ...process.env, CLAUDE_CONFIG_DIR: configDir };
    return new Promise((resolve) => {
      execFile(this.bin(provider), ['mcp', ...args], { env, timeout: this.timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' });
      });
    });
  }

  private static oneLine(stdout: string, stderr: string): string {
    const text = stderr.trim() || stdout.trim();
    const lines = text.split('\n').map((l) => l.replace(/\r/g, '').trim())
      .filter((l) => l && !/^WARNING: proceeding/.test(l)); // codex's benign PATH-alias notice
    const summary = lines.reverse().find((l) => /error|fail|added|removed|already/i.test(l)) ?? lines[0] ?? '';
    return summary.slice(0, 240) || 'done';
  }

  /** Claude's user-scoped servers, read straight from the config file. */
  private claudeServers(configDir: string): McpServerSpec[] {
    try {
      const raw = JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8')) as {
        mcpServers?: Record<string, { type?: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }>;
      };
      return Object.entries(raw.mcpServers ?? {}).map(([name, s]) => ({
        name,
        transport: s.type === 'http' || s.type === 'sse' || s.url ? 'http' : 'stdio',
        command: s.command,
        args: s.args,
        env: s.env,
        url: s.url,
        headers: s.headers,
      }));
    } catch {
      return [];
    }
  }

  /** Codex's servers, via its own `--json` listing. */
  private async codexServers(configDir: string): Promise<McpServerSpec[]> {
    const r = await this.run('codex', configDir, ['list', '--json']);
    try {
      const arr = JSON.parse(r.stdout) as {
        name: string;
        transport?: { type?: string; command?: string; args?: string[]; env?: Record<string, string> | null; url?: string };
      }[];
      if (!Array.isArray(arr)) return [];
      return arr.map((s) => {
        const t = s.transport ?? {};
        const http = t.type !== 'stdio';
        return {
          name: s.name,
          transport: http ? 'http' as const : 'stdio' as const,
          command: t.command,
          args: t.args,
          env: t.env ?? undefined,
          url: t.url,
        };
      });
    } catch {
      return [];
    }
  }

  /** Every configured server, per provider, aggregated across that provider's
   *  accounts so drift ("only on 1 of 3") is visible. */
  async list(): Promise<{ servers: McpServerInfo[]; accounts: Record<string, number> }> {
    const out: McpServerInfo[] = [];
    const counts: Record<string, number> = {};
    for (const provider of ['claude', 'codex'] as ProviderId[]) {
      const accounts = this.opts.accounts(provider);
      counts[provider] = accounts.length;
      if (!accounts.length) continue;
      const perAccount = await Promise.all(accounts.map(async (a) => ({
        account: a.name,
        servers: provider === 'codex' ? await this.codexServers(a.configDir) : this.claudeServers(a.configDir),
      })));
      const byName = new Map<string, { spec: McpServerSpec; accounts: string[]; differing: string[] }>();
      for (const { account, servers } of perAccount) {
        for (const s of servers) {
          const cur = byName.get(s.name);
          if (!cur) { byName.set(s.name, { spec: s, accounts: [account], differing: [] }); continue; }
          cur.accounts.push(account);
          // Compare the definition, not just the name — an account carrying a
          // different command/url for the same name is drift worth surfacing.
          if (JSON.stringify(normalize(cur.spec)) !== JSON.stringify(normalize(s))) cur.differing.push(account);
        }
      }
      for (const [name, v] of byName) {
        out.push({
          ...v.spec,
          name,
          provider,
          accountCount: v.accounts.length,
          totalAccounts: accounts.length,
          synced: v.accounts.length === accounts.length && v.differing.length === 0,
          differing: v.differing,
        });
      }
    }
    out.sort((a, b) => (a.provider === b.provider ? a.name.localeCompare(b.name) : a.provider.localeCompare(b.provider)));
    return { servers: out, accounts: counts };
  }

  /** Args for this provider's "add" form of the spec. */
  private static addArgs(provider: ProviderId, s: McpServerSpec): string[] {
    if (provider === 'codex') {
      if (s.transport === 'http') return ['add', s.name, '--url', s.url ?? ''];
      const env = Object.entries(s.env ?? {}).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
      // `--` separates codex's own flags from the server's command line.
      return ['add', s.name, ...env, '--', s.command ?? '', ...(s.args ?? [])];
    }
    const json = s.transport === 'http'
      ? { type: 'http', url: s.url ?? '', ...(s.headers && Object.keys(s.headers).length ? { headers: s.headers } : {}) }
      : { type: 'stdio', command: s.command ?? '', args: s.args ?? [], ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}) };
    return ['add-json', s.name, JSON.stringify(json), '-s', 'user'];
  }

  private static removeArgs(provider: ProviderId, name: string): string[] {
    return provider === 'codex' ? ['remove', name] : ['remove', name, '-s', 'user'];
  }

  private async eachAccount(provider: ProviderId, build: (dir: string) => Promise<{ ok: boolean; stdout: string; stderr: string }>): Promise<McpOpResult> {
    const accounts = this.opts.accounts(provider);
    if (!accounts.length) return { ok: false, perDir: [] };
    const perDir = await Promise.all(accounts.map(async (a) => {
      const r = await build(a.configDir);
      return { account: a.name, ok: r.ok, message: McpServerManager.oneLine(r.stdout, r.stderr) };
    }));
    return { ok: perDir.every((p) => p.ok), perDir };
  }

  add(provider: ProviderId, spec: McpServerSpec): Promise<McpOpResult> {
    return this.eachAccount(provider, (dir) => this.run(provider, dir, McpServerManager.addArgs(provider, spec)));
  }

  /** Neither CLI has an "edit": claude REFUSES a duplicate name (leaving the old
   *  definition in place) and codex silently overwrites. Remove-then-add gives
   *  both the same, predictable result. */
  update(provider: ProviderId, spec: McpServerSpec): Promise<McpOpResult> {
    return this.eachAccount(provider, async (dir) => {
      await this.run(provider, dir, McpServerManager.removeArgs(provider, spec.name)); // may not exist — that's fine
      return this.run(provider, dir, McpServerManager.addArgs(provider, spec));
    });
  }

  remove(provider: ProviderId, name: string): Promise<McpOpResult> {
    return this.eachAccount(provider, (dir) => this.run(provider, dir, McpServerManager.removeArgs(provider, name)));
  }
}

/** Compare only the fields that define the server, ignoring key order/absence. */
function normalize(s: McpServerSpec): unknown {
  return {
    transport: s.transport,
    command: s.command ?? '',
    args: s.args ?? [],
    env: Object.fromEntries(Object.entries(s.env ?? {}).sort()),
    url: s.url ?? '',
    headers: Object.fromEntries(Object.entries(s.headers ?? {}).sort()),
  };
}

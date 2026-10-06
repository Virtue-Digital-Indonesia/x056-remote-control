import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
  strictReads?: boolean;
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

  /** Scope onboarding writes to one account, leaving active peers untouched. */
  forAccounts(accounts: { name: string; configDir: string }[], provider: ProviderId): McpServerManager {
    return new McpServerManager({ ...this.opts, strictReads: true, accounts: (p) => p === provider ? accounts : [] });
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
    if (!existsSync(join(configDir, '.claude.json'))) return [];
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
      if (this.opts.strictReads) throw new Error('MCP inventory unavailable');
      return [];
    }
  }

  /** Codex's servers, via its own `--json` listing. */
  private async codexServers(configDir: string): Promise<McpServerSpec[]> {
    const r = await this.run('codex', configDir, ['list', '--json']);
    if (this.opts.strictReads && !r.ok) throw new Error('MCP inventory unavailable');
    try {
      const arr = JSON.parse(r.stdout) as {
        name: string;
        transport?: { type?: string; command?: string; args?: string[]; env?: Record<string, string> | null; url?: string; http_headers?: Record<string, string> | null };
      }[];
      if (!Array.isArray(arr)) { if (this.opts.strictReads) throw new Error('Invalid MCP inventory'); return []; }
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
          // Without this an Obscura written with a bearer read back as
          // header-less: never `synced`, and update() would have dropped it.
          headers: t.http_headers ?? undefined,
        };
      });
    } catch {
      if (this.opts.strictReads) throw new Error('MCP inventory unavailable');
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

  /**
   * `codex mcp add --url` has no way to attach headers, but config.toml accepts
   * them -- `[mcp_servers.X] url = … [mcp_servers.X.http_headers] …` -- and
   * `codex mcp list --json` / `codex mcp remove` both round-trip a hand-written
   * table (verified on 0.153.4). So an http server WITH headers is written
   * straight into the file; everything else still goes through the CLI.
   */
  private static codexNeedsToml(provider: ProviderId, s: McpServerSpec): boolean {
    return provider === 'codex' && s.transport === 'http' && !!s.headers && Object.keys(s.headers).length > 0;
  }

  private static tomlStr(v: string): string { return JSON.stringify(v); }

  /** Drop every `[mcp_servers.<name>]` and `[mcp_servers.<name>.*]` table. */
  static stripCodexTable(toml: string, name: string): string {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('^\\[mcp_servers\\.' + esc + '(?:\\.[^\\]]*)?\\][^\\n]*\\n(?:(?!^\\[)[^\\n]*\\n?)*', 'gm');
    return toml.replace(re, '').replace(/\n{3,}/g, '\n\n');
  }

  private writeCodexHttpTable(configDir: string, s: McpServerSpec): { ok: boolean; stdout: string; stderr: string } {
    const file = join(configDir, 'config.toml');
    let body = '';
    try { if (existsSync(file)) body = readFileSync(file, 'utf8'); } catch { /* start fresh */ }
    body = McpServerManager.stripCodexTable(body, s.name).trimEnd();
    const lines = [
      `[mcp_servers.${s.name}]`,
      `url = ${McpServerManager.tomlStr(s.url ?? '')}`,
      '',
      `[mcp_servers.${s.name}.http_headers]`,
      ...Object.entries(s.headers ?? {}).map(([k, v]) => `${McpServerManager.tomlStr(k)} = ${McpServerManager.tomlStr(v)}`),
    ];
    try {
      writeFileSync(file, (body ? body + '\n\n' : '') + lines.join('\n') + '\n');
      return { ok: true, stdout: `Added global MCP server '${s.name}' (config.toml, with headers).`, stderr: '' };
    } catch (err) {
      return { ok: false, stdout: '', stderr: (err as Error).message };
    }
  }

  add(provider: ProviderId, spec: McpServerSpec): Promise<McpOpResult> {
    if (McpServerManager.codexNeedsToml(provider, spec)) {
      return this.eachAccount(provider, async (dir) => this.writeCodexHttpTable(dir, spec));
    }
    return this.eachAccount(provider, (dir) => this.run(provider, dir, McpServerManager.addArgs(provider, spec)));
  }

  /** Neither CLI has an "edit": claude REFUSES a duplicate name (leaving the old
   *  definition in place) and codex silently overwrites. Remove-then-add gives
   *  both the same, predictable result. */
  update(provider: ProviderId, spec: McpServerSpec): Promise<McpOpResult> {
    return this.eachAccount(provider, async (dir) => {
      await this.run(provider, dir, McpServerManager.removeArgs(provider, spec.name)); // may not exist — that's fine
      if (McpServerManager.codexNeedsToml(provider, spec)) return this.writeCodexHttpTable(dir, spec);
      return this.run(provider, dir, McpServerManager.addArgs(provider, spec));
    });
  }

  remove(provider: ProviderId, name: string): Promise<McpOpResult> {
    return this.eachAccount(provider, (dir) => this.run(provider, dir, McpServerManager.removeArgs(provider, name)));
  }

  /**
   * The url of an http server called `name`, read from the account files
   * (no CLI). The first account of either provider that has it wins.
   */
  findHttpServer(name: string): { name: string; url: string } | undefined {
    for (const provider of ['claude', 'codex'] as ProviderId[]) {
      for (const a of this.opts.accounts(provider)) {
        const s = provider === 'codex' ? readCodexHttp(a.configDir, name) : readClaudeHttp(a.configDir, name);
        if (s?.url) return { name, url: s.url };
      }
    }
    return undefined;
  }

  /**
   * Rewrite ONLY the headers of an http server, on every account of both
   * providers that has it, by editing the config files directly.
   *
   * Why not update(): that is remove-then-add through each CLI, i.e. two CLI
   * launches per account. The OAuth refresher calls this about every two
   * hours on every live account, and a CLI start on a live account dir is how
   * an account gets signed out (CLAUDE.md). A file edit also keeps every other
   * key the server's entry carries. Accounts without the server are skipped,
   * never created. Each write is read back before it counts as done.
   */
  async setHttpHeaders(name: string, mutate: (headers: Record<string, string>) => Record<string, string>): Promise<HeaderApplyResult[]> {
    const out: HeaderApplyResult[] = [];
    for (const provider of ['claude', 'codex'] as ProviderId[]) {
      for (const a of this.opts.accounts(provider)) {
        try {
          const r = provider === 'codex' ? setCodexHeaders(a.configDir, name, mutate) : setClaudeHeaders(a.configDir, name, mutate);
          if (r) out.push({ provider, account: a.name, ok: true, changed: r.changed });
        } catch (err) {
          out.push({ provider, account: a.name, ok: false, changed: false, message: (err as Error).message.slice(0, 200) });
        }
      }
    }
    return out;
  }
}

export interface HeaderApplyResult { provider: ProviderId; account: string; ok: boolean; changed: boolean; message?: string }

const sameHeaders = (a: Record<string, string>, b: Record<string, string>) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** Write through a symlink to its target, atomically, keeping the mode. */
function writeAtomic(file: string, body: string): void {
  const real = realpathSync(file);
  const mode = statSync(real).mode & 0o777;
  const tmp = `${real}.x056-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, body, { mode });
  try { renameSync(tmp, real); } catch (e) { try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
}

function readClaudeHttp(configDir: string, name: string): { url?: string; headers: Record<string, string> } | undefined {
  const file = join(configDir, '.claude.json');
  if (!existsSync(file)) return undefined;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }> };
  const s = raw.mcpServers?.[name];
  if (!s?.url) return undefined;
  return { url: s.url, headers: { ...(s.headers ?? {}) } };
}

function setClaudeHeaders(configDir: string, name: string, mutate: (h: Record<string, string>) => Record<string, string>): { changed: boolean } | undefined {
  const file = join(configDir, '.claude.json');
  if (!existsSync(file)) return undefined;
  // Read-modify-write of the WHOLE file: the CLI keeps a lot more than
  // mcpServers in it. The window between read and rename is milliseconds.
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }> };
  const s = raw.mcpServers?.[name];
  if (!s?.url) return undefined;
  const next = mutate({ ...(s.headers ?? {}) });
  if (sameHeaders(s.headers ?? {}, next)) return { changed: false };
  if (Object.keys(next).length) s.headers = next; else delete s.headers;
  writeAtomic(file, JSON.stringify(raw, null, 2));
  const back = readClaudeHttp(configDir, name);
  if (!back || !sameHeaders(back.headers, next)) throw new Error('headers did not read back');
  return { changed: true };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tableRe = (name: string, sub: string) =>
  new RegExp('^\\[mcp_servers\\.' + esc(name) + sub + '\\][^\\n]*\\n?(?:(?!\\[)[^\\n]*\\n?)*', 'm');

/** `[mcp_servers.<name>]` url and `[mcp_servers.<name>.http_headers]`, the
 *  two shapes the gateway (and `codex mcp add --url`) write. */
function readCodexHttp(configDir: string, name: string): { url?: string; headers: Record<string, string>; inlineHeaders: boolean } | undefined {
  const file = join(configDir, 'config.toml');
  if (!existsSync(file)) return undefined;
  const toml = readFileSync(file, 'utf8');
  const main = tableRe(name, '').exec(toml)?.[0];
  if (!main) return undefined;
  const url = /^url\s*=\s*("(?:[^"\\]|\\.)*")\s*$/m.exec(main)?.[1];
  const headers: Record<string, string> = {};
  const sub = tableRe(name, '\\.http_headers').exec(toml)?.[0];
  for (const line of (sub ?? '').split('\n').slice(1)) {
    const m = /^\s*("(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*")\s*$/.exec(line);
    if (m) headers[m[1].startsWith('"') ? JSON.parse(m[1]) : m[1]] = JSON.parse(m[2]);
  }
  return { url: url ? JSON.parse(url) : undefined, headers, inlineHeaders: /^http_headers\s*=/m.test(main) };
}

function setCodexHeaders(configDir: string, name: string, mutate: (h: Record<string, string>) => Record<string, string>): { changed: boolean } | undefined {
  const file = join(configDir, 'config.toml');
  const cur = readCodexHttp(configDir, name);
  if (!cur?.url) return undefined;
  // An inline `http_headers = {…}` cannot be rewritten without a TOML parser,
  // and adding a sub-table beside it would define the key twice.
  if (cur.inlineHeaders) throw new Error('http_headers is an inline table; edit it once in the panel to convert it');
  const next = mutate({ ...cur.headers });
  if (sameHeaders(cur.headers, next)) return { changed: false };
  let toml = readFileSync(file, 'utf8').replace(tableRe(name, '\\.http_headers'), '').trimEnd();
  if (Object.keys(next).length) {
    const lines = Object.entries(next).map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`);
    toml += `\n\n[mcp_servers.${name}.http_headers]\n${lines.join('\n')}`;
  }
  writeAtomic(file, toml.replace(/\n{3,}/g, '\n\n') + '\n');
  const back = readCodexHttp(configDir, name);
  if (!back || !sameHeaders(back.headers, next)) throw new Error('headers did not read back');
  return { changed: true };
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

/**
 * Secrets never leave the gateway through the settings API.
 *
 * Header values (e.g. `Authorization: Bearer obsk_…`) and env values (e.g.
 * `KNOWLEDGE_API_TOKEN`) were returned verbatim by GET /api/mcp/servers, so
 * any panel session could read the one Obscura token every account shares.
 * They are masked to `«redacted-XXXX»` (the last four characters, so two
 * tokens can still be told apart). The panel's Edit form sends back what it
 * was given; `restoreRedacted` swaps each masked value for the stored one,
 * and refuses a masked value it has nothing to restore from.
 */
export const REDACTED_RE = /^«redacted(?:-[^»]{0,8})?»$/;
const mask = (v: string): string => `«redacted${v.length >= 12 ? '-' + v.slice(-4) : ''}»`;
const maskAll = (o?: Record<string, string>) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, mask(String(v))])) : o);

export function redactSpec<T extends McpServerSpec>(s: T): T {
  return { ...s, ...(s.headers ? { headers: maskAll(s.headers) } : {}), ...(s.env ? { env: maskAll(s.env) } : {}) };
}

/** Put the real values back for every masked one; throws if one is unknown. */
export function restoreRedacted(spec: McpServerSpec, stored: McpServerSpec | undefined): McpServerSpec {
  const fix = (field: 'headers' | 'env'): Record<string, string> | undefined => {
    const given = spec[field];
    if (!given) return given;
    return Object.fromEntries(Object.entries(given).map(([k, v]) => {
      if (!REDACTED_RE.test(v)) return [k, v];
      const real = stored?.[field]?.[k];
      if (real === undefined) throw new Error(`${field === 'headers' ? 'Header' : 'Variable'} ${k} is masked and has no stored value; enter it again`);
      return [k, real];
    }));
  };
  return { ...spec, ...(spec.headers ? { headers: fix('headers') } : {}), ...(spec.env ? { env: fix('env') } : {}) };
}

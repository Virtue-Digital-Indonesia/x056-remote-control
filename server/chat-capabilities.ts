import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Account } from '../src/accounts.js';
import type { Project } from './projects.js';
import { PluginManager } from './plugins.js';
import { McpServerManager } from './mcp-servers.js';
import { readState, writeState } from './workspace-store.js';

export interface ChatCapability { key: string; name: string; kind: 'skill' | 'plugin' | 'mcp'; state: 'ready' | 'installed' | 'authorization-needed' | 'unavailable'; fingerprint?: string; description?: string; invocation?: string; reason?: string }
export interface CapabilityRequirement { key: string; fingerprint?: string }
export interface AccountCapabilities { account: string; capabilities: ChatCapability[]; errors: string[] }
const exec = promisify(execFile);

function skillFingerprint(path: string): string {
  const hash = createHash('sha256'), seen = new Set<string>();
  let bytes = 0, files = 0;
  const visit = (dir: string, relative = '') => {
    const real = realpathSync(dir); if (seen.has(real)) return; seen.add(real);
    for (const name of readdirSync(dir).sort()) {
      if (['.git','node_modules','__pycache__','.venv'].includes(name)) continue;
      const full = join(dir, name), st = statSync(full);
      if (st.isDirectory()) { visit(full, relative + name + '/'); continue; }
      if (!st.isFile() || ++files > 2000 || (bytes += st.size) > 30 * 1024 * 1024) throw new Error('Skill support files exceed discovery limit');
      hash.update(relative + name + '\0').update(readFileSync(full));
    }
  };
  visit(dirname(path)); return hash.digest('hex');
}

/** Read the actual Codex skill resolution for this CWD and this account. No turn
 * is started and credentials stay in the provider's process. */
async function codexInventory(configDir: string, cwd: string): Promise<{ skills: any[]; servers: any[]; apps: any[] }> {
  const child = spawn('codex', ['app-server'], { cwd, env: { ...process.env, CODEX_HOME: configDir }, detached: true, stdio: ['pipe','pipe','ignore'] });
  const waiting = new Map<number, { resolve: (data: any) => void; reject: (error: Error) => void }>();
  let id = 0;
  const rpc = (method: string, params: unknown) => new Promise<any>((resolve, reject) => { const n = ++id; waiting.set(n, { resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { try { const data = JSON.parse(line), pending = waiting.get(data.id); if (pending) { waiting.delete(data.id); data.error ? pending.reject(new Error('Provider capability discovery failed')) : pending.resolve(data.result); } } catch {} });
  const fail = () => { for (const p of waiting.values()) p.reject(new Error('Provider capability discovery unavailable')); waiting.clear(); };
  child.on('error', fail); child.on('close', fail);
  const timer = setTimeout(() => { fail(); try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, 30_000);
  try {
    await rpc('initialize', { clientInfo: { name: 'x056-capabilities', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
    const skills = await rpc('skills/list', { cwds: [cwd], forceReload: true });
    const servers: any[] = [], apps: any[] = [];
    for (const [method, target, params] of [['mcpServerStatus/list', servers, {}], ['app/list', apps, { forceRefetch: true }]] as const) {
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const response = await rpc(method, { ...params, limit: 100, ...(cursor ? { cursor } : {}) });
        target.push(...(response.data ?? [])); cursor = response.nextCursor; if (!cursor) break;
      }
    }
    return { skills: (skills.data ?? []).flatMap((x: any) => x.skills ?? []), servers, apps };
  } finally { clearTimeout(timer); lines.close(); fail(); try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }
}

export class ChatCapabilities {
  private cache = new Map<string, { at: number; promise: Promise<AccountCapabilities[]> }>();
  constructor(private readonly state: string, private readonly accounts: () => Account[], private readonly plugins: PluginManager,
    private readonly mcp: McpServerManager, private readonly claudePath = 'claude',
    private readonly collectOverride?: (account: Account, chat: Project) => Promise<AccountCapabilities>) {}
  requirements(chatId: string): CapabilityRequirement[] {
    return readState<Record<string, CapabilityRequirement[]>>(join(this.state, 'chat-requirements.json'), {})[chatId] ?? [];
  }
  invalidate(): void { this.cache.clear(); }
  setRequirements(chatId: string, requirements: CapabilityRequirement[]): void {
    if (!Array.isArray(requirements) || requirements.length > 40 || requirements.some(r => !r || typeof r.key !== 'string' || !/^(skill|plugin|mcp):.{1,240}$/.test(r.key) || (r.fingerprint !== undefined && typeof r.fingerprint !== 'string'))) throw new Error('Invalid tool requirements');
    const all = readState<Record<string, CapabilityRequirement[]>>(join(this.state, 'chat-requirements.json'), {});
    all[chatId] = requirements; writeState(join(this.state, 'chat-requirements.json'), all); this.cache.delete(chatId);
  }
  async inventory(chat: Project, force = false): Promise<AccountCapabilities[]> {
    const cached = this.cache.get(chat.id);
    if (!force && cached && cached.at > Date.now() - 30_000) return cached.promise;
    const promise = Promise.all(this.accounts().filter(a => a.provider === chat.provider).map(a =>
      (this.collectOverride ? this.collectOverride(a, chat) : this.collect(a, chat)).catch(() => ({ account: a.name, capabilities: [], errors: ['Capability discovery unavailable. Refresh after checking this account.'] }))));
    this.cache.set(chat.id, { at: Date.now(), promise }); return promise;
  }
  async blocked(chat: Project): Promise<Record<string, string[]>> {
    const required = this.requirements(chat.id); if (!required.length) return {};
    const inventory = await this.inventory(chat), blocked: Record<string, string[]> = {};
    for (const account of inventory) {
      const reasons: string[] = [];
      for (const req of required) {
        const item = account.capabilities.find(c => c.key === req.key);
        if (!item || item.state !== 'ready') reasons.push(`Required tool ${req.key}: ${item?.state ?? 'unavailable'}`);
        else if (req.fingerprint && req.fingerprint !== item.fingerprint) reasons.push(`Required tool ${req.key}: account version differs`);
      }
      if (reasons.length) blocked[account.account] = reasons;
    }
    return blocked;
  }
  private async collect(account: Account, chat: Project): Promise<AccountCapabilities> {
    const provider = account.provider, errors: string[] = [], capabilities: ChatCapability[] = [];
    const [plugins, mcp] = await Promise.all([
      this.plugins.forAccounts([account], provider).list(provider), this.mcp.forAccounts([account], provider).list(),
    ]);
    let native: Awaited<ReturnType<typeof codexInventory>> | undefined;
    let claudeHealth = '';
    if (provider === 'codex') {
      try { native = await codexInventory(account.configDir, chat.cwd); } catch { errors.push('Provider tool discovery unavailable'); }
    } else {
      try { claudeHealth = (await exec(this.claudePath, ['mcp','list'], { cwd: chat.cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: account.configDir }, timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout; } catch { errors.push('MCP connection check unavailable'); }
    }
    let skills: { name: string; path: string; description?: string; enabled?: boolean; pluginId?: string }[] = native?.skills ?? [];
    if (provider === 'claude') {
      const discovered = new Map<string, typeof skills[number]>();
      const scan = (root: string, prefix = '', depth = 0) => {
        if (depth > 3) return;
        let entries: string[]; try { entries = readdirSync(root); } catch { return; }
        for (const name of entries) {
          const folder = join(root, name), path = join(folder, 'SKILL.md');
          try {
            const content = readFileSync(path, 'utf8');
            const skillName = prefix + (/^name:\s*["']?([^\n"']+)/m.exec(content)?.[1].trim() || name);
            discovered.set(skillName, { name: skillName, path, enabled: true, description: /^description:\s*["']?([^\n"']+)/m.exec(content)?.[1].trim() });
          } catch { if (name === '.system') scan(folder, prefix, depth + 1); }
        }
      };
      scan(join(account.configDir, 'skills'));
      const installed = readState<{ plugins: Record<string, { installPath?: string }[]> }>(join(account.configDir, 'plugins', 'installed_plugins.json'), { plugins: {} });
      for (const plugin of plugins.plugins.filter(p => p.enabled)) for (const entry of installed.plugins?.[plugin.id] ?? []) if (entry.installPath) scan(join(entry.installPath, 'skills'), plugin.name + ':');
      scan(join(chat.cwd, '.claude', 'skills'));
      skills = [...discovered.values()];
    }
    for (const skill of skills) {
      let fingerprint: string | undefined;
      try { fingerprint = skillFingerprint(skill.path); } catch {}
      capabilities.push({ key: 'skill:' + skill.name, name: skill.name, kind: 'skill', state: skill.enabled === false || !fingerprint ? 'unavailable' : 'ready', fingerprint, description: skill.description, invocation: (provider === 'codex' ? '$' : '/') + skill.name });
    }
    for (const server of mcp.servers) {
      const status = native?.servers.find(s => s.name === server.name);
      const line = claudeHealth.split('\n').find(line => line.startsWith(server.name + ':')) || '';
      const state = status?.runtimeStatus === 'authenticationRequired' || status?.authStatus === 'notLoggedIn' || /needs authentication/i.test(line) ? 'authorization-needed'
        : status?.runtimeStatus === 'connected' || (status && Object.keys(status.tools ?? {}).length > 0) || /connected/i.test(line) && !/disconnected/i.test(line) ? 'ready' : 'installed';
      // Configuration identity excludes credentials, which intentionally differ.
      const fingerprint = createHash('sha256').update(JSON.stringify([server.name, server.transport, server.command, server.args, server.url])).digest('hex');
      capabilities.push({ key: 'mcp:' + server.name, name: server.name, kind: 'mcp', state, fingerprint });
    }
    for (const plugin of plugins.plugins) {
      const app = native?.apps.find(a => a.pluginDisplayNames?.some((n: string) => n.toLowerCase() === plugin.name.toLowerCase()) || a.name?.toLowerCase() === plugin.name.toLowerCase());
      const remote = plugin.id.endsWith('@openai-curated-remote');
      const state = !plugin.enabled ? 'unavailable' : app ? (app.isAccessible && app.isEnabled !== false ? 'ready' : 'authorization-needed')
        : remote ? 'installed' : skills.some(s => s.pluginId === plugin.id || s.name.startsWith(plugin.name + ':')) ? 'ready' : 'installed';
      capabilities.push({ key: 'plugin:' + plugin.id, name: plugin.name, kind: 'plugin', state, fingerprint: plugin.version });
    }
    capabilities.push({ key: 'mcp:x056', name: 'x056', kind: 'mcp', state: 'ready', fingerprint: 'chat-files-v1' });
    return { account: account.name, capabilities, errors };
  }
}

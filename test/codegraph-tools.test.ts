import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodegraphClient, type CodegraphConfig } from '../server/codegraph.js';
import { TOOLS, callTool } from '../scripts/x056-mcp-tools.mjs';

/** Stand-in knowledge service: records what it was asked, answers plausibly. */
let server: Server;
let base = '';
let seen: { path: string; body: any; auth?: string; serviceId?: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({
        path: req.url ?? '',
        body,
        auth: req.headers.authorization as string | undefined,
        serviceId: req.headers['x-tdai-service-id'] as string | undefined,
      });
      res.setHeader('Content-Type', 'application/json');
      if ((req.url ?? '').includes('/wiki/search')) {
        res.end(JSON.stringify({ code: 0, message: 'ok', data: { results: [{ path: 'wiki/obscura/auth.md', score: 3.2 }] } }));
      } else {
        res.end(JSON.stringify({ code: 0, message: 'ok', data: { text: 'Callers of x (1 found)\n- launch - server/manager.ts:1377', isError: false } }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => { server?.close(); });

const cfg = (over: Partial<CodegraphConfig> = {}): CodegraphConfig => ({
  url: base, token: 'tok', serviceId: 'x056', teamId: 'x056',
  defaultGraphId: 'cg-default', defaultWikiId: 'wiki-default', ...over,
});

describe('CodegraphClient', () => {
  it('fills in the graph id, since nothing exposes a way to discover it', async () => {
    seen = [];
    await new CodegraphClient(cfg()).call('code_callers', { symbol: 'launch' });
    expect(seen[0].body.code_graph_id).toBe('cg-default');
    expect(seen[0].body.symbol).toBe('launch');
  });

  // Regression: the service registers code queries under SHORT names. Building
  // `/code-graph/code_callers` from the tool name 404s against the real service
  // — a mock that accepts any path will not notice, so assert the path itself.
  it('strips the code_ prefix to hit the route the service actually registers', async () => {
    seen = [];
    const c = new CodegraphClient(cfg());
    for (const t of ['code_search', 'code_callers', 'code_callees', 'code_impact', 'code_node', 'code_explore']) {
      await c.call(t, { symbol: 'x', query: 'x' });
    }
    expect(seen.map((s) => s.path)).toEqual([
      '/v3/code-graph/search', '/v3/code-graph/callers', '/v3/code-graph/callees',
      '/v3/code-graph/impact', '/v3/code-graph/node', '/v3/code-graph/explore',
    ]);
  });

  // Regression: page/read wants a batch (`refs: string[]`) and 400s on `ref`.
  it('widens a single ref into the refs array page/read requires', async () => {
    seen = [];
    await new CodegraphClient(cfg()).call('wiki_read', { ref: 'wiki/obscura/auth.md' });
    expect(seen[0].path).toBe('/v3/wiki/page/read');
    expect(seen[0].body.refs).toEqual(['wiki/obscura/auth.md']);
    expect(seen[0].body.ref).toBeUndefined();
  });

  it('lets an explicit id win over the default', async () => {
    seen = [];
    await new CodegraphClient(cfg()).call('code_callers', { symbol: 'x', code_graph_id: 'cg-other' });
    expect(seen[0].body.code_graph_id).toBe('cg-other');
  });

  it('sends the token and tenant header the service demands', async () => {
    seen = [];
    await new CodegraphClient(cfg()).call('code_search', { query: 'x' });
    expect(seen[0].auth).toBe('Bearer tok');
    expect(seen[0].serviceId).toBe('x056');
  });

  it('adds team_id for wiki routes but NOT code routes (which reject unexpected fields)', async () => {
    seen = [];
    const c = new CodegraphClient(cfg());
    await c.call('wiki_search', { query: 'deploy' });
    await c.call('code_search', { query: 'deploy' });
    const wiki = seen.find((s) => s.path.includes('/wiki/'))!;
    const code = seen.find((s) => s.path.includes('/code-graph/'))!;
    expect(wiki.body.team_id).toBe('x056');
    expect(wiki.body.wiki_id).toBe('wiki-default');
    expect(code.body.team_id).toBeUndefined();
  });

  it('refuses to call an unauthenticated service rather than leaking queries to it', async () => {
    const c = new CodegraphClient(cfg({ token: '' }));
    expect(c.enabled).toBe(false);
    await expect(c.call('code_search', { query: 'x' })).rejects.toThrow(/not configured/);
  });

  it('rejects a tool name it does not know instead of forwarding it as a path', async () => {
    await expect(new CodegraphClient(cfg()).call('../../etc/passwd', {})).rejects.toThrow(/unknown code graph tool/);
  });

  it('surfaces the service error message', async () => {
    const c = new CodegraphClient(cfg({ url: 'http://127.0.0.1:1' }));
    await expect(c.call('code_search', { query: 'x' })).rejects.toThrow();
  });
});

describe('MCP tool surface', () => {
  it('offers the code + memory tools alongside the conversation ones', () => {
    const names = TOOLS.map((t: { name: string }) => t.name);
    for (const n of ['list_projects', 'send_message', 'code_search', 'code_callers', 'code_impact', 'wiki_search', 'wiki_read']) {
      expect(names).toContain(n);
    }
  });

  it('gives every tool a schema — a client cannot call one without it', () => {
    for (const t of TOOLS) expect(t.inputSchema).toBeTruthy();
  });

  it('routes a code tool through the gateway, never straight at the service', async () => {
    const calls: string[] = [];
    const api = async (path: string, opts: RequestInit = {}) => {
      calls.push(path);
      expect(JSON.parse(String(opts.body)).tool).toBe('code_callers');
      return { data: { text: 'Callers of launch (1 found)' } };
    };
    const out = await callTool(api, 'code_callers', { symbol: 'launch' });
    expect(calls).toEqual(['/api/codegraph/call']); // the token stays server-side
    expect(out).toContain('Callers of launch');
  });

  it('renders wiki search hits as readable lines rather than raw JSON', async () => {
    const api = async () => ({ data: { results: [{ path: 'wiki/obscura/auth.md', score: 3.2 }] } });
    const out = await callTool(api, 'wiki_search', { query: 'auth' });
    expect(out).toContain('wiki/obscura/auth.md');
    expect(out).not.toContain('{');
  });

  it('says so plainly when a search matches nothing', async () => {
    const api = async () => ({ data: { results: [] } });
    expect(await callTool(api, 'wiki_search', { query: 'zzz' })).toBe('(no matches)');
  });

  // Regression: page/read answers [{ref, content}]. Rendering items as bare
  // paths threw the content away, so wiki_read returned only a filename.
  it('renders the page body for wiki_read, not just its path', async () => {
    const api = async () => ({ data: { items: [{ ref: 'wiki/x/a.md', content: 'the actual memory text' }] } });
    const out = await callTool(api, 'wiki_read', { ref: 'wiki/x/a.md' });
    expect(out).toContain('the actual memory text');
    expect(out).toContain('wiki/x/a.md');
  });
});

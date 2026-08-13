import { readFileSync } from 'node:fs';

/**
 * Thin client for the code-graph / memory-wiki knowledge service.
 *
 * The service runs on the dind sidecar (see docs/codegraph.md) and is NOT
 * reachable from outside this container. This client exists so the MCP tools can
 * be offered over the gateway's own authenticated endpoints — an external client
 * (Claude Desktop, claude.ai) talks only to the gateway, and the gateway holds
 * the knowledge-service token server-side. The token therefore never leaves the
 * machine, and there is no second public surface to secure.
 */

export const CODEGRAPH = Symbol('x056-codegraph');

export interface CodegraphConfig {
  /** Base URL of the knowledge service, e.g. http://dind:8421 */
  url: string;
  /** Bearer token; empty disables the tools rather than calling unauthenticated. */
  token: string;
  serviceId: string;
  teamId: string;
  /** Defaults so callers need not know the ids — there is no "list graphs" tool. */
  defaultGraphId: string;
  defaultWikiId: string;
}

/** Read a value that may be provided inline or as a path to a secret file. */
function fromEnvOrFile(value: string | undefined, file: string | undefined): string {
  if (value) return value.trim();
  if (!file) return '';
  try { return readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

export function codegraphConfigFromEnv(): CodegraphConfig {
  return {
    url: process.env.X056_CODEGRAPH_URL ?? 'http://dind:8421',
    token: fromEnvOrFile(process.env.X056_CODEGRAPH_TOKEN, process.env.X056_CODEGRAPH_TOKEN_FILE ?? '/app/state/tools/codegraph-token.txt'),
    serviceId: process.env.X056_CODEGRAPH_SERVICE_ID ?? 'x056',
    teamId: process.env.X056_CODEGRAPH_TEAM_ID ?? 'x056',
    defaultGraphId: fromEnvOrFile(process.env.X056_CODEGRAPH_GRAPH_ID, '/app/state/tools/cgid-x056.txt'),
    defaultWikiId: fromEnvOrFile(process.env.X056_CODEGRAPH_WIKI_ID, '/app/state/tools/wikiid-memories.txt'),
  };
}

/**
 * Query tools → their route on the knowledge service.
 *
 * The service registers code queries under SHORT names (`/code-graph/callers`,
 * not `/code-graph/code_callers`) while the MCP tools are the prefixed ones, so
 * the prefix has to be stripped or every call 404s.
 */
const CODE_TOOLS = new Set(['code_search', 'code_explore', 'code_callers', 'code_callees', 'code_impact', 'code_node', 'code_files', 'code_status']);
const WIKI_ROUTES: Record<string, string> = {
  wiki_search: '/wiki/search',
  wiki_read: '/wiki/page/read',
  wiki_list: '/wiki/page/ls',
};

export class CodegraphClient {
  constructor(private readonly cfg: CodegraphConfig) {}

  /** False when no token is configured — the endpoints then 503 rather than
   *  silently calling an unauthenticated service. */
  get enabled(): boolean { return Boolean(this.cfg.token && this.cfg.url); }

  get defaults(): { graphId: string; wikiId: string } {
    return { graphId: this.cfg.defaultGraphId, wikiId: this.cfg.defaultWikiId };
  }

  async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.enabled) throw new Error('code graph is not configured on this gateway');

    const isCode = CODE_TOOLS.has(tool);
    const route = isCode ? `/code-graph/${tool.replace(/^code_/, '')}` : WIKI_ROUTES[tool];
    if (!route) throw new Error(`unknown code graph tool: ${tool}`);

    // Fill in the ids the caller almost never has. Code query routes are
    // id-only and reject unexpected fields, so team_id goes to wiki routes only.
    const body: Record<string, unknown> = { ...args };
    if (isCode) {
      body.code_graph_id = args.code_graph_id ?? this.cfg.defaultGraphId;
    } else {
      body.wiki_id = args.wiki_id ?? this.cfg.defaultWikiId;
      body.team_id = args.team_id ?? this.cfg.teamId;
      // page/read takes a BATCH (`refs`), but one-page-at-a-time is the sane
      // tool shape, so accept `ref` and widen it here.
      if (typeof body.ref === 'string') {
        body.refs = [body.ref];
        delete body.ref;
      }
    }

    const res = await fetch(`${this.cfg.url.replace(/\/$/, '')}/v3${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tdai-service-id': this.cfg.serviceId,
        Authorization: `Bearer ${this.cfg.token}`,
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null) as { code?: number; message?: string; data?: unknown } | null;
    if (!res.ok || (json && json.code !== 0)) {
      throw new Error(json?.message ?? `code graph service returned ${res.status}`);
    }
    return json?.data ?? null;
  }
}

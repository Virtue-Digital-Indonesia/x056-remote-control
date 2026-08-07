import { All, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
// The SAME tool implementations the stdio bridge uses (see x056-mcp-tools.mjs) —
// one definition, two transports, so an external client and a spawned session
// always see an identical tool surface.
import { SERVER_INFO, TOOLS, callTool } from '../scripts/x056-mcp-tools.mjs';

export const MCP_HTTP_CONFIG = Symbol('x056-mcp-http-config');
export interface McpHttpConfig {
  /** Optional override for the gateway base URL the bridge calls back on.
   *  Normally left unset — the request's own loopback address is used. */
  url?: string;
  token: string;
}

/** Protocol revisions we can speak. We echo the client's if we know it, else
 *  answer with the newest — the handshake rule in the MCP spec. */
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0];

interface JsonRpcRequest { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

const err = (id: unknown, code: number, message: string): unknown => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const ok = (id: unknown, result: unknown): unknown => ({ jsonrpc: '2.0', id: id ?? null, result });

/**
 * MCP over Streamable HTTP, so any standard MCP client — Claude Desktop, another
 * Claude Code, an SDK — can drive this gateway's conversations remotely. The
 * in-container sessions keep using the stdio bridge; this is the same server
 * exposed over the network.
 *
 * Deliberately STATELESS: no Mcp-Session-Id is issued, every POST is answered on
 * its own, and there is no server->client stream (GET is refused per spec). The
 * tools are request/response, so a session would buy nothing and cost a
 * reconnect story.
 *
 * Auth is the gateway's normal one (global guard): `Authorization: Bearer <token>`
 * or `?token=`.
 */
@Controller('mcp')
export class McpHttpController {
  constructor(@Inject(MCP_HTTP_CONFIG) private readonly cfg: McpHttpConfig) {}

  /** The bridge's own call back into the gateway API, mirroring the stdio one.
   *  The base is derived from the REQUEST's own socket (loopback + the port we
   *  are actually listening on) rather than captured at boot: that is correct
   *  under any port/proxy arrangement, and it never leaves the machine. */
  private apiFor = (req: Request) => async (path: string, opts: RequestInit = {}): Promise<unknown> => {
    const base = this.cfg.url || `http://127.0.0.1:${req.socket.localPort}`;
    const res = await fetch(base + path, {
      ...opts,
      headers: { Authorization: `Bearer ${this.cfg.token}`, 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body as { message?: string } | null)?.message ?? `gateway returned ${res.status}`);
    return body;
  };

  @Post()
  @HttpCode(200) // a JSON-RPC response is 200, not Nest's default 201
  async rpc(@Req() req: Request, @Res() res: Response): Promise<void> {
    const api = this.apiFor(req);
    const payload = req.body as JsonRpcRequest | JsonRpcRequest[];
    // Batches were dropped in the 2025-06-18 revision but older clients may
    // still send them; answering an array with an array costs nothing.
    if (Array.isArray(payload)) {
      const out = (await Promise.all(payload.map((m) => this.handle(m, api)))).filter((r) => r !== null);
      if (!out.length) { res.status(202).end(); return; }
      res.status(200).json(out);
      return;
    }
    const out = await this.handle(payload ?? {}, api);
    // A notification (no id) gets no body — just an acknowledgement.
    if (out === null) { res.status(202).end(); return; }
    res.status(200).json(out);
  }

  /** The spec's optional server->client SSE stream. We have nothing to push, and
   *  saying so plainly is better than holding a socket open forever. */
  @All()
  fallback(@Req() req: Request, @Res() res: Response): void {
    if (req.method === 'POST') return; // handled above
    res.status(405).set('Allow', 'POST').json(err(null, -32000, 'this server only supports POST (no server-initiated stream)'));
  }

  private async handle(msg: JsonRpcRequest, api: (p: string, o?: RequestInit) => Promise<unknown>): Promise<unknown | null> {
    const { id, method, params } = msg ?? {};
    const isNotification = id === undefined || id === null;
    if (!method) return isNotification ? null : err(id, -32600, 'invalid request: no method');

    // Notifications never get a reply, whatever they are.
    if (method.startsWith('notifications/')) return null;

    if (method === 'initialize') {
      const asked = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '';
      return ok(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : LATEST_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'Read and drive the conversations running on this x056 gateway: list_projects and list_conversations to find one, '
          + 'read_conversation for its history, send_message to talk to it. send_message requires the human operator to approve '
          + 'it in the panel before anything is delivered.',
      });
    }
    if (method === 'ping') return ok(id, {});
    if (method === 'tools/list') return ok(id, { tools: TOOLS });
    if (method === 'tools/call') {
      const name = typeof params?.name === 'string' ? params.name : '';
      const args = (params?.arguments as Record<string, unknown>) ?? {};
      try {
        const text = await callTool(api, name, args);
        return ok(id, { content: [{ type: 'text', text }] });
      } catch (e) {
        // A failing tool is a RESULT with isError, not a protocol error — that's
        // what lets the model see what went wrong and adjust.
        return ok(id, { content: [{ type: 'text', text: `error: ${(e as Error).message}` }], isError: true });
      }
    }
    // resources/prompts aren't offered; say so with the standard code.
    return isNotification ? null : err(id, -32601, `method not found: ${method}`);
  }
}

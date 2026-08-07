// Types for the shared MCP tool module (plain ESM so the stdio bridge can run it
// under bare node, while the TS server imports it too).
export declare const SERVER_INFO: { name: string; version: string };

export declare const TOOLS: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}[];

/** Run one tool. `api` is the caller's authenticated fetch into the gateway.
 *  Returns the text payload for the MCP `content` block; throws on failure. */
export declare function callTool(
  api: (path: string, opts?: RequestInit) => Promise<unknown>,
  name: string,
  args: Record<string, unknown>,
): Promise<string>;

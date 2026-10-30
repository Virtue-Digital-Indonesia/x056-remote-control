// Types for the shared MCP tool module (plain ESM so the stdio bridge can run it
// under bare node, while the TS server imports it too).
export declare const SERVER_INFO: { name: string; version: string };

/** How a tool result held at a relay checkpoint begins (send_message, steer, answer_question). */
export declare const RELAY_CHECKPOINT_PREFIX: string;

export declare const TOOLS: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}[];

/** The tools a bridge advertises: TOOLS, plus the Bot's own (notify_user,
 *  status_overview) only inside a Bot turn (X056_BOT=1 with a self session). */
export declare function listTools(): typeof TOOLS;

/** Run one tool. `api` is the caller's authenticated fetch into the gateway.
 *  Returns the text payload for the MCP `content` block; throws on failure. */
export declare function callTool(
  api: (path: string, opts?: RequestInit) => Promise<unknown>,
  name: string,
  args: Record<string, unknown>,
): Promise<string>;

export interface ToolResult {
  content: [{ type: 'text'; text: string }, ...({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]];
  structuredContent: Record<string, unknown>;
}
export declare function callToolResult(
  api: (path: string, opts?: RequestInit) => Promise<unknown>,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult>;

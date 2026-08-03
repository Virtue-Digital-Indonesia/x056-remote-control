import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { AuthGuard } from './auth.guard.js';
import { ApiController, STATE_DIR, PUSH_SERVICE, WEBAUTHN_SERVICE, SESSION_STORE, PLUGIN_MANAGER, MCP_SERVER_MANAGER } from './api.controller.js';
import { SessionManager } from './manager.js';
import { PushService } from './push.js';
import { PluginManager } from './plugins.js';
import { McpServerManager } from './mcp-servers.js';
import { WebAuthnService, SessionStore } from './webauthn.js';
import type { TurnOptions } from '../src/turn.js';

/** Wire the x056 MCP bridge (scripts/x056-mcp.mjs) into every spawned turn, so
 *  sessions get tools to read/message other conversations and projects through
 *  the gateway API. Writes the claude-style --mcp-config file into stateDir and
 *  returns the pieces codex needs to build its own -c overrides. */
function buildMcpWiring(cfg: GatewayConfig): TurnOptions['mcp'] {
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'x056-mcp.mjs');
  const url = process.env.X056_MCP_URL ?? `http://localhost:${process.env.PORT ?? '4056'}`;
  const env = { X056_URL: url, X056_TOKEN: cfg.token };
  const configPath = join(cfg.stateDir, 'mcp-x056.json');
  mkdirSync(cfg.stateDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ mcpServers: { x056: { command: 'node', args: [script], env } } }, null, 2));
  return { configPath, command: 'node', args: [script], env };
}

export interface GatewayConfig {
  token: string;
  stateDir: string;
  workspaceRoot: string;
  claudePath?: string;
  /** Panel HTML read per-request from here (bind-mounted for live UI updates). */
  panelPath?: string;
  /** Read-only mount of the user's interactive ~/.claude/projects for resume. */
  interactiveProjectsDir?: string;
}

export function buildModule(cfg: GatewayConfig): unknown {
  const manager = new SessionManager({
    stateDir: cfg.stateDir,
    workspaceRoot: cfg.workspaceRoot,
    claudePath: cfg.claudePath,
    interactiveProjectsDir: cfg.interactiveProjectsDir,
    manageProcessSignals: true,
    mcp: buildMcpWiring(cfg),
  });

  // Web Push: notify the (installed) panel when a turn needs the user, finishes,
  // or was interrupted. Subscribing here also replays any startup orphan events
  // so a swap-interrupted turn pushes a "resume" notification.
  const push = new PushService(
    cfg.stateDir,
    (pid) => manager.projectName(pid) ?? 'a project',
    (sessionId) => manager.hasAutopilot(sessionId),
  );
  manager.subscribe((e) => { push.notify(e.kind, e.data).catch(() => {}); });

  // Passkey (WebAuthn) auth + the sessions it mints. The guard accepts either the
  // X056_TOKEN (fallback) or a valid passkey session cookie.
  const webauthn = new WebAuthnService(cfg.stateDir);
  const sessions = new SessionStore(cfg.stateDir);

  // Claude Code plugin management, replicated across every Claude failover
  // account so an installed plugin is usable no matter which account is active.
  const plugins = new PluginManager({
    claudePath: cfg.claudePath,
    claudeDirs: PluginManager.claudeDirsFromRegistry(join(cfg.stateDir, 'accounts.json')),
  });

  // MCP servers, likewise replicated across every account of a provider so one
  // stays configured no matter which account a turn lands on.
  const mcpServers = new McpServerManager({
    claudePath: cfg.claudePath,
    accounts: McpServerManager.accountsFromRegistry(join(cfg.stateDir, 'accounts.json')),
  });

  @Module({
    controllers: [ApiController],
    providers: [
      { provide: SessionManager, useValue: manager },
      { provide: PUSH_SERVICE, useValue: push },
      { provide: WEBAUTHN_SERVICE, useValue: webauthn },
      { provide: SESSION_STORE, useValue: sessions },
      { provide: PLUGIN_MANAGER, useValue: plugins },
      { provide: MCP_SERVER_MANAGER, useValue: mcpServers },
      { provide: STATE_DIR, useValue: cfg.stateDir },
      { provide: APP_GUARD, useFactory: (reflector: Reflector) => new AuthGuard(cfg.token, sessions, reflector), inject: [Reflector] },
    ],
  })
  class AppModule {}
  return AppModule;
}

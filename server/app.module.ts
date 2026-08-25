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
import { CODEGRAPH, CodegraphClient, codegraphConfigFromEnv, type CodegraphConfig } from './codegraph.js';
import { MEMORY_WRITER, MemoryWriter } from './memories.js';
import { PROVISIONER, AccountProvisioner } from './provision.js';
import { CRON, CronScheduler } from './cron.js';
import { DESIGN_LOGIN, DesignLoginManager } from './design-login.js';
import { DESIGN_CONSENT, DesignConsentGranter } from './design-consent.js';
import { TEMPLATES, TemplateStore } from './templates.js';
import { McpHttpController, MCP_HTTP_CONFIG } from './mcp-http.controller.js';
import { OAuthController, OAUTH_STORE, OAUTH_DEPS } from './oauth.controller.js';
import { OAuthStore } from './oauth.js';
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
  /** Code-graph / memory-wiki service. Defaults from env; tests inject their own. */
  codegraph?: CodegraphConfig;
}

export function buildModule(cfg: GatewayConfig): unknown {
  // Declared before the manager so the onAccountAdded hook can reach it.
  let provisioner: AccountProvisioner;
  const manager = new SessionManager({
    stateDir: cfg.stateDir,
    workspaceRoot: cfg.workspaceRoot,
    claudePath: cfg.claudePath,
    interactiveProjectsDir: cfg.interactiveProjectsDir,
    manageProcessSignals: true,
    mcp: buildMcpWiring(cfg),
    onAccountAdded: (acct) => {
      provisioner.provision(acct)
        .then((r) => {
          const n = r.plugins.length + r.skills.length + r.flags.length;
          if (n) console.log(`[provision] ${acct.name}: ${r.plugins.length} plugin(s), ${r.skills.length} skill(s), ${r.flags.length} flag(s)`);
          for (const e of r.errors) console.warn(`[provision] ${acct.name}: ${e}`);
        })
        .catch((e) => console.warn(`[provision] ${acct.name} failed:`, e));
    },
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

  // OAuth 2.1 for remote MCP clients (Claude Desktop / claude.ai connectors
  // refuse a bare token and insist on discovery + dynamic registration + PKCE).
  const oauth = new OAuthStore(cfg.stateDir);

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

  // Scheduled prompts. Delivery goes through the same path a cross-conversation
  // send uses, so a job firing at a conversation that is mid-turn queues behind
  // it instead of failing.
  const cron = new CronScheduler({
    stateDir: cfg.stateDir,
    deliver: (projectId, sessionId, prompt) => manager.deliverMcpMessage(projectId, sessionId, prompt),
  });
  cron.start();

  // Claude Design's browser login, per account. Must outlive a turn: the
  // operator authorizes in a browser and pastes a code back.
  const designLogin = new DesignLoginManager({ claudePath: cfg.claudePath, cwd: cfg.workspaceRoot });

  // Design AGENT access — a different grant from the login above, and the one
  // the mcp__claude-design__* tools actually check. Non-interactive, so a plain
  // `claude -p` does it.
  const designConsent = new DesignConsentGranter({ claudePath: cfg.claudePath, cwd: cfg.workspaceRoot });

  provisioner = new AccountProvisioner(
    () => McpServerManager.accountsFromRegistry(join(cfg.stateDir, 'accounts.json'))('claude'),
    plugins,
    designConsent,
  );

  @Module({
    controllers: [ApiController, McpHttpController, OAuthController],
    providers: [
      { provide: SessionManager, useValue: manager },
      { provide: PUSH_SERVICE, useValue: push },
      { provide: WEBAUTHN_SERVICE, useValue: webauthn },
      { provide: SESSION_STORE, useValue: sessions },
      { provide: PLUGIN_MANAGER, useValue: plugins },
      { provide: MCP_SERVER_MANAGER, useValue: mcpServers },
      { provide: CODEGRAPH, useValue: new CodegraphClient(cfg.codegraph ?? codegraphConfigFromEnv()) },
      // Memories live in the Claude config dirs; codex accounts have no such tree.
      { provide: PROVISIONER, useValue: provisioner },
      { provide: CRON, useValue: cron },
      { provide: DESIGN_LOGIN, useValue: designLogin },
      { provide: DESIGN_CONSENT, useValue: designConsent },
      { provide: TEMPLATES, useValue: new TemplateStore(cfg.stateDir) },
      { provide: MEMORY_WRITER, useValue: new MemoryWriter(() => McpServerManager.accountsFromRegistry(join(cfg.stateDir, 'accounts.json'))('claude')) },
      // The HTTP MCP endpoint calls back into this gateway with the same
      // credentials the spawned stdio bridge uses. No URL: it derives its own
      // loopback address per request, so it is right on any port.
      { provide: MCP_HTTP_CONFIG, useValue: { token: cfg.token } },
      { provide: OAUTH_STORE, useValue: oauth },
      { provide: OAUTH_DEPS, useValue: { sessions, token: cfg.token } },
      { provide: STATE_DIR, useValue: cfg.stateDir },
      { provide: APP_GUARD, useFactory: (reflector: Reflector) => new AuthGuard(cfg.token, sessions, reflector, oauth), inject: [Reflector] },
    ],
  })
  class AppModule {}
  return AppModule;
}

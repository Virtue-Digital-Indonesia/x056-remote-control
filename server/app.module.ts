import { Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { AuthGuard } from './auth.guard.js';
import { ApiController, STATE_DIR, PUSH_SERVICE, WEBAUTHN_SERVICE, SESSION_STORE } from './api.controller.js';
import { SessionManager } from './manager.js';
import { PushService } from './push.js';
import { WebAuthnService, SessionStore } from './webauthn.js';

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

  @Module({
    controllers: [ApiController],
    providers: [
      { provide: SessionManager, useValue: manager },
      { provide: PUSH_SERVICE, useValue: push },
      { provide: WEBAUTHN_SERVICE, useValue: webauthn },
      { provide: SESSION_STORE, useValue: sessions },
      { provide: STATE_DIR, useValue: cfg.stateDir },
      { provide: APP_GUARD, useFactory: (reflector: Reflector) => new AuthGuard(cfg.token, sessions, reflector), inject: [Reflector] },
    ],
  })
  class AppModule {}
  return AppModule;
}

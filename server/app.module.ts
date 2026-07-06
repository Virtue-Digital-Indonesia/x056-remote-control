import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard.js';
import { ApiController, STATE_DIR, PUSH_SERVICE } from './api.controller.js';
import { SessionManager } from './manager.js';
import { PushService } from './push.js';

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
    (pid) => manager.hasAutopilot(pid),
  );
  manager.subscribe((e) => { push.notify(e.kind, e.data).catch(() => {}); });

  @Module({
    controllers: [ApiController],
    providers: [
      { provide: SessionManager, useValue: manager },
      { provide: PUSH_SERVICE, useValue: push },
      { provide: STATE_DIR, useValue: cfg.stateDir },
      { provide: APP_GUARD, useFactory: () => new AuthGuard(cfg.token) },
    ],
  })
  class AppModule {}
  return AppModule;
}

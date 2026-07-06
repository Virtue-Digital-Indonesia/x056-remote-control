import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard.js';
import { ApiController, STATE_DIR } from './api.controller.js';
import { SessionManager } from './manager.js';

export interface GatewayConfig {
  token: string;
  stateDir: string;
  workspaceRoot: string;
  claudePath?: string;
  /** Panel HTML read per-request from here (bind-mounted for live UI updates). */
  panelPath?: string;
}

export function buildModule(cfg: GatewayConfig): unknown {
  const manager = new SessionManager({
    stateDir: cfg.stateDir,
    workspaceRoot: cfg.workspaceRoot,
    claudePath: cfg.claudePath,
    manageProcessSignals: true,
  });

  @Module({
    controllers: [ApiController],
    providers: [
      { provide: SessionManager, useValue: manager },
      { provide: STATE_DIR, useValue: cfg.stateDir },
      { provide: APP_GUARD, useFactory: () => new AuthGuard(cfg.token) },
    ],
  })
  class AppModule {}
  return AppModule;
}

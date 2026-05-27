// Shared context handed to every IPC domain module. Each ipc/<domain>.ts
// exports a `register<Domain>Ipc(ctx)` function that wires its handlers
// against this context — keeps domain modules pure (no module-level state),
// makes main.ts the single owner of orchestrator/window/auto-approve state,
// and avoids the cross-module-import cycle we'd hit if each domain reached
// back into main.ts directly.

import type { BrowserWindow } from 'electron';
import type { Orchestrator, OrchestratorEvent } from '../orchestrator.js';

export interface IpcContext {
  liveWindow: () => BrowserWindow | null;
  emitToRenderer: (e: OrchestratorEvent) => void;
  getOrchestrator: () => Orchestrator | null;
  setOrchestrator: (o: Orchestrator | null) => void;
  getRecapPending: () => Orchestrator | null;
  setRecapPending: (o: Orchestrator | null) => void;
  getAutoApprove: () => boolean;
  setAutoApprove: (v: boolean) => void;
  getCurrentCwd: () => string | null;
  setCurrentCwd: (v: string | null) => void;
  getClaudeShadowHome: () => string | null;
  nativeConfirmDestructive: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<boolean>;
}

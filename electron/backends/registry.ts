// registry.ts — singleton registry of all CLI backend adapters.
//
// Populated at app startup with all known backends. Provides lookup by ID,
// listing, and availability checking. The orchestrator and settings UI
// query this registry to discover and create backend sessions.

import type { CliBackend, BackendAuthConfig } from './cli-backend.js';
import { ClaudeCodeBackend } from './claude-code-adapter.js';
import { CodexBackend } from './codex-adapter.js';
import { KimiBackend } from './kimi-adapter.js';
import { QoderBackend } from './qoder-adapter.js';
import { CustomBackend, type CustomBackendOptions } from './custom-adapter.js';
import type { ConfirmDestructive } from '../claude-session.js';

export interface BackendStatus {
  backend: CliBackend;
  available: boolean;
  binaryPath: string | null;
}

export class BackendRegistry {
  private backends = new Map<string, CliBackend>();

  register(backend: CliBackend): void {
    this.backends.set(backend.id, backend);
  }

  /** Remove a backend by ID. Used when a custom backend is deleted. */
  unregister(id: string): void {
    this.backends.delete(id);
  }

  get(id: string): CliBackend | undefined {
    return this.backends.get(id);
  }

  list(): CliBackend[] {
    return Array.from(this.backends.values());
  }

  /** Return backends with their availability status. */
  listWithStatus(): BackendStatus[] {
    return this.list().map((backend) => {
      const binaryPath = backend.resolveBinary();
      return {
        backend,
        available: binaryPath !== null,
        binaryPath,
      };
    });
  }

  /** Only backends whose binary resolves successfully. */
  available(): CliBackend[] {
    return this.list().filter((b) => b.resolveBinary() !== null);
  }

  /** Check if a specific backend is available. */
  isAvailable(id: string): boolean {
    const backend = this.backends.get(id);
    return backend !== undefined && backend.resolveBinary() !== null;
  }

  /** Register a custom backend from user-provided options. */
  registerCustom(options: CustomBackendOptions): void {
    this.register(new CustomBackend(options));
  }
}

// ── Singleton instance ─────────────────────────────────────────────────────────

let instance: BackendRegistry | null = null;

export function getBackendRegistry(confirmDestructive?: ConfirmDestructive): BackendRegistry {
  if (!instance) {
    instance = new BackendRegistry();
    // Register all known backends. Order determines default selection.
    instance.register(new ClaudeCodeBackend({ confirmDestructive }));
    instance.register(new CodexBackend());
    instance.register(new KimiBackend());
    instance.register(new QoderBackend());
  }
  return instance;
}

/** Register custom backends from settings. Called after settings are loaded. */
export function registerCustomBackends(): void {
  const registry = getBackendRegistry();
  // Lazy import to avoid circular dependency at module load time.
  // settings-loader will call this after settings are available.
  let listCustomBackends: () => import('../store.js').CustomBackendEntry[];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const store = require('../store.js');
    listCustomBackends = store.listCustomBackends;
  } catch {
    // Settings module not yet available — custom backends will be registered later
    return;
  }

  try {
    const customBackends = listCustomBackends();
    for (const entry of customBackends) {
      registry.registerCustom({
        id: entry.id,
        displayName: entry.displayName,
        binaryName: entry.binaryName,
        apiKeyEnv: entry.apiKeyEnv,
        baseUrlEnv: entry.baseUrlEnv,
        defaultModel: entry.defaultModel,
        installHint: entry.installHint,
        npmPackage: entry.npmPackage,
      });
    }
  } catch (err) {
    console.error('[registry] failed to register custom backends:', err);
  }
}

/** Reset the singleton (for testing). */
export function resetBackendRegistry(): void {
  instance = null;
}

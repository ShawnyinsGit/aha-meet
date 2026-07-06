// claude-code-adapter.ts — wraps the existing ClaudeSession into the
// CliBackend/BackendSession interface.
//
// This adapter does NOT replace or modify ClaudeSession. It constructs one
// internally and translates SessionEvent → BackendSessionEvent at the
// boundary. Since NormalizedMessage is designed to be SDKMessage-compatible
// (same `message.content` shape), the translation is mostly a pass-through.
//
// The Orchestrator/WorkerScheduler consume BackendSession; this adapter is
// the bridge that lets them use Claude Code without knowing about SDK types.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ClaudeSession, type SessionEvent, type InputPriority as CSInputPriority } from '../claude-session.js';
import { mergedSubprocessEnv } from '../settings-loader.js';
import type {
  BackendSession,
  BackendSessionConfig,
  BackendSessionEvent,
  BackendAuthConfig,
  BackendCapabilities,
  CliBackend,
  InputPriority,
  UserContentBlock,
} from './cli-backend.js';
import type { AutoApproveScope } from '../auto-approve-policy.js';
import type { ConfirmDestructive } from '../claude-session.js';

const require_ = createRequire(import.meta.url);

// ── Binary resolution ─────────────────────────────────────────────────────────
// Reuses the same resolution logic as ClaudeSession but exposed as a standalone
// function for the registry's availability check.

function unpackify(p: string): string {
  return p.replace(/[\\/]app\.asar[\\/]/, (_, sep) => `${sep}app.asar.unpacked${sep}`);
}

export function resolveClaudeBinary(): string | undefined {
  const platform = process.platform;
  const arch = process.arch === 'x64' ? `${platform}-x64` : `${platform}-arm64`;
  const subpkg = `@anthropic-ai/claude-agent-sdk-${arch}/claude`;

  try {
    const sdkPkg = require_.resolve('@anthropic-ai/claude-agent-sdk/package.json');
    const sdkRequire = createRequire(sdkPkg);
    const p = unpackify(sdkRequire.resolve(subpkg));
    if (existsSync(p)) return p;
  } catch { /* fall through */ }

  try {
    const p = unpackify(require_.resolve(subpkg));
    if (existsSync(p)) return p;
  } catch { /* fall through */ }

  const guesses = [
    process.resourcesPath && `${process.resourcesPath}/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/node_modules/${subpkg}`,
    process.resourcesPath && `${process.resourcesPath}/app.asar.unpacked/node_modules/${subpkg}`,
  ].filter((x): x is string => !!x);
  for (const g of guesses) {
    if (existsSync(g)) return g;
  }
  return undefined;
}

// ── Session adapter ────────────────────────────────────────────────────────────
// Wraps a ClaudeSession instance and exposes the BackendSession interface.

class ClaudeCodeSession implements BackendSession {
  private inner: ClaudeSession;

  constructor(
    config: BackendSessionConfig,
    emit: (e: BackendSessionEvent) => void,
    confirmDestructive?: ConfirmDestructive,
  ) {
    // Translate BackendSessionConfig → ClaudeSession constructor options.
    // The NormalizedMessage shape is SDKMessage-compatible, so we can pass
    // the session events through with minimal wrapping.
    this.inner = new ClaudeSession({
      emit: (event: SessionEvent) => {
        // SessionEvent.message is already SDKMessage-shaped, which is
        // NormalizedMessage-compatible. Pass through directly.
        emit(event as BackendSessionEvent);
      },
      cwd: config.cwd,
      sessionOptions: config.extra as Record<string, unknown> | undefined,
      autoApproveScope: config.autoApproveScope ?? 'off',
      envOverride: config.env,
      confirmDestructive,
    });
  }

  start(): void {
    this.inner.start();
  }

  end(): void {
    this.inner.end();
  }

  sendUserText(text: string, priority?: InputPriority): void {
    this.inner.sendUserText(text, (priority ?? 'normal') as CSInputPriority);
  }

  sendUserContent(content: UserContentBlock[], priority?: InputPriority): void {
    // UserContentBlock is compatible with SDKUserMessage content blocks
    // (same { type: 'text', text } and { type: 'image', source } shapes).
    this.inner.sendUserContent(
      content as Parameters<ClaudeSession['sendUserContent']>[0],
      (priority ?? 'normal') as CSInputPriority,
    );
  }

  resolvePermission(id: string, decision: 'allow' | 'deny', message?: string): void {
    this.inner.resolvePermission(id, decision, message);
  }

  async interrupt(): Promise<void> {
    await this.inner.interrupt();
  }

  setAutoApproveScope(scope: AutoApproveScope): void {
    this.inner.setAutoApproveScope(scope);
  }

  async setPermissionMode(mode: string): Promise<void> {
    await this.inner.setPermissionMode(
      mode as Parameters<ClaudeSession['setPermissionMode']>[0],
    );
  }
}

// ── Backend implementation ─────────────────────────────────────────────────────

const CLAUDE_CODE_CAPABILITIES: BackendCapabilities = {
  displayName: 'Claude Code',
  iconId: 'claude',
  mcp: true,
  permissions: true,
  systemPrompt: true,
  skills: true,
  interrupt: true,
  defaultModel: 'claude-sonnet-4-20250514',
  models: [
    'claude-sonnet-4-20250514',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-20250514',
  ],
  npmPackage: '@anthropic-ai/claude-agent-sdk',
  installHint: 'Bundled with AhaMeet',
};

export class ClaudeCodeBackend implements CliBackend {
  readonly id = 'claude-code';
  readonly capabilities = CLAUDE_CODE_CAPABILITIES;
  private confirmDestructive?: ConfirmDestructive;

  constructor(opts?: { confirmDestructive?: ConfirmDestructive }) {
    this.confirmDestructive = opts?.confirmDestructive;
  }

  createSession(
    config: BackendSessionConfig,
    emit: (e: BackendSessionEvent) => void,
  ): BackendSession {
    return new ClaudeCodeSession(config, emit, this.confirmDestructive);
  }

  resolveBinary(): string | null {
    return resolveClaudeBinary() ?? null;
  }

  buildEnv(auth: BackendAuthConfig, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const base = mergedSubprocessEnv();
    const env: NodeJS.ProcessEnv = { ...base, ...extra };

    if (auth.apiKey) {
      env.ANTHROPIC_API_KEY = auth.apiKey;
    }
    if (auth.baseUrl) {
      env.ANTHROPIC_BASE_URL = auth.baseUrl;
    }
    if (auth.model) {
      env.ANTHROPIC_MODEL = auth.model;
    }

    return env;
  }

  async validateAuth(config: BackendAuthConfig): Promise<{ ok: boolean; error?: string }> {
    if (config.authMode === 'apikey' && !config.apiKey) {
      return { ok: false, error: 'API key is required for apikey auth mode' };
    }
    return { ok: true };
  }

  async loginOAuth(): Promise<{ ok: boolean; error?: string }> {
    // Delegate to the CLI's built-in auth login command.
    // The orchestrator handles this via `claude auth login` in a terminal.
    return { ok: false, error: 'OAuth login is handled by the Claude CLI directly. Run "claude auth login" in a terminal.' };
  }

  async checkAuthStatus(): Promise<{ loggedIn: boolean }> {
    // Check if the Claude CLI has valid OAuth credentials.
    // This is a simplified check — the real implementation would query
    // the CLI's auth status.
    const binary = this.resolveBinary();
    return { loggedIn: binary !== null };
  }
}

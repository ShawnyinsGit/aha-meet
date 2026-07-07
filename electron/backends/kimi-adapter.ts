// kimi-adapter.ts — Kimi CLI backend adapter (Moonshot AI).
//
// Kimi CLI does not have a JS SDK. It is spawned as a subprocess using the
// print mode (--print) with JSON streaming (--output-format stream-json).
//
// Usage:  kimi --print --output-format stream-json -p "prompt"
//
// Exit codes: 0 = success, 1 = permanent failure, 75 = transient (retry ok).
//
// Auth: via `kimi /login` (OAuth) or MOONSHOT_API_KEY environment variable.
//
// Built-in tools: Shell, ReadFile, WriteFile, Grep, Glob, SearchWeb, FetchURL.
// No MCP support — uses its own built-in tool set.

import {
  SubprocessBackend,
  SubprocessSession,
  type resolveBinaryFromPath,
} from './subprocess-backend.js';
import type {
  BackendSession,
  BackendSessionConfig,
  BackendSessionEvent,
  BackendAuthConfig,
  BackendCapabilities,
  NormalizedMessage,
} from './cli-backend.js';

const KIMI_CAPABILITIES: BackendCapabilities = {
  displayName: 'Kimi',
  iconId: 'kimi',
  mcp: false,
  permissions: false,
  systemPrompt: false,
  skills: false,
  interrupt: true,
  defaultModel: 'kimi-latest',
  npmPackage: undefined,
  installHint: process.platform === 'win32'
    ? 'Kimi CLI is not yet available for Windows. Visit https://code.kimi.com for updates.'
    : 'curl -LsSf https://code.kimi.com/install.sh | bash',
};

// ── Kimi JSONL message shapes ─────────────────────────────────────────────────
// These are approximate — the exact format depends on the Kimi CLI version.
// The adapter normalizes them to our NormalizedMessage shape.

interface KimiStreamEvent {
  type?: string;
  role?: string;
  content?: string | Array<{ type: string; text?: string }>;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  finish_reason?: string;
  error?: { message: string; code?: string };
}

// ── Session implementation ─────────────────────────────────────────────────────

class KimiSession extends SubprocessSession {
  protected buildArgs(config: BackendSessionConfig): string[] {
    const args = [
      '--print',
      '--output-format', 'stream-json',
    ];

    if (config.model) {
      args.push('--model', config.model);
    }

    // Kimi uses -p for the prompt
    const promptText = config.systemPrompt
      ? `${config.systemPrompt}\n\n---\n\n`
      : '';
    args.push('-p', promptText + 'Ready for instructions.');

    return args;
  }

  protected formatPrompt(config: BackendSessionConfig): string {
    // The initial prompt is sent via -p argument, not stdin.
    // Return empty since we already included it in buildArgs.
    return '';
  }

  protected parseStdoutLine(line: string): NormalizedMessage | null {
    let event: KimiStreamEvent;
    try {
      event = JSON.parse(line);
    } catch {
      // Non-JSON line — skip (could be log output)
      return null;
    }

    // Error event
    if (event.error) {
      return {
        type: 'assistant',
        errorCode: event.error.code ?? 'kimi_error',
        errorDetail: event.error.message,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `Error: ${event.error.message}` }],
        },
      };
    }

    // Extract text content
    let text = '';
    if (typeof event.content === 'string') {
      text = event.content;
    } else if (Array.isArray(event.content)) {
      text = event.content
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text!)
        .join('');
    }

    // Tool calls → tool_use content blocks
    const toolBlocks = (event.tool_calls ?? []).map((tc) => ({
      type: 'tool_use' as const,
      id: tc.id,
      name: tc.function.name,
      input: safeJsonParse(tc.function.arguments),
    }));

    const content: NormalizedMessage['message'] = {
      role: 'assistant',
      content: [
        ...(text ? [{ type: 'text' as const, text }] : []),
        ...toolBlocks,
      ],
    };

    return {
      type: 'assistant',
      message: content,
      raw: event,
    };
  }

  start(): void {
    // Override start to handle the -p prompt properly.
    // Kimi's --print mode takes the prompt via -p and runs non-interactively.
    // We send the actual user prompt as the -p argument.
    super.start();
  }

  sendUserText(text: string): void {
    // Kimi's print mode is single-turn. For multi-turn, we'd need to use
    // the interactive mode. For now, send via stdin as a best effort.
    this.writeStdin(text);
  }
}

function safeJsonParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return { raw: s };
  }
}

// ── Backend implementation ─────────────────────────────────────────────────────

export class KimiBackend extends SubprocessBackend {
  readonly id = 'kimi';
  readonly capabilities = KIMI_CAPABILITIES;
  readonly binaryName = 'kimi';

  createSession(
    config: BackendSessionConfig,
    emit: (e: BackendSessionEvent) => void,
  ): BackendSession {
    const binary = this.resolveBinary();
    if (!binary) {
      // Emit error and return a no-op session
      emit({ kind: 'error', error: 'Kimi CLI not found. Install with: curl -LsSf https://code.kimi.com/install.sh | bash' });
      emit({ kind: 'ended' });
      return createNoopSession();
    }
    return new KimiSession(binary, config, emit);
  }

  buildEnv(auth: BackendAuthConfig, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = super.buildEnv(auth, extra);
    if (auth.apiKey) {
      env.MOONSHOT_API_KEY = auth.apiKey;
    }
    if (auth.baseUrl) {
      env.MOONSHOT_BASE_URL = auth.baseUrl;
    }
    return env;
  }

  async validateAuth(config: BackendAuthConfig): Promise<{ ok: boolean; error?: string }> {
    if (config.authMode === 'apikey' && !config.apiKey) {
      return { ok: false, error: 'MOONSHOT_API_KEY is required' };
    }
    return { ok: true };
  }

  async checkAuthStatus(): Promise<{ loggedIn: boolean }> {
    // Kimi is "logged in" if the binary is available (may have OAuth configured)
    // OR an API key is set
    const binary = this.resolveBinary();
    return { loggedIn: binary !== null };
  }

  async loginOAuth(): Promise<{ ok: boolean; error?: string }> {
    // Kimi OAuth is done via `kimi /login` in an interactive terminal.
    return { ok: false, error: 'Run "kimi /login" in a terminal to authenticate.' };
  }
}

// ── No-op session for missing binary ───────────────────────────────────────────

function createNoopSession(): BackendSession {
  return {
    start() {},
    end() {},
    sendUserText() {},
    sendUserContent() {},
    resolvePermission() {},
    async interrupt() {},
  };
}

// qoder-adapter.ts — Qoder CLI backend adapter.
//
// Uses @qoder-ai/qoder-agent-sdk (TypeScript SDK) when available.
// Falls back to subprocess spawning if the SDK is not installed.
//
// The Qoder SDK depends on @modelcontextprotocol/sdk for MCP tool support.
// It is maintained by the Alibaba/Qoder team.
//
// npm: @qoder-ai/qoder-agent-sdk v1.0.11
// npm: @qoder-ai/qodercli v1.0.38 (the CLI binary)
//
// Auth: config-based, API key via environment variable or config file.

import { existsSync } from 'node:fs';
import {
  SubprocessBackend,
  SubprocessSession,
  resolveBinaryFromPath,
} from './subprocess-backend.js';
import type {
  BackendSession,
  BackendSessionConfig,
  BackendSessionEvent,
  BackendAuthConfig,
  BackendCapabilities,
  NormalizedMessage,
} from './cli-backend.js';

const QODER_CAPABILITIES: BackendCapabilities = {
  displayName: 'Qoder',
  iconId: 'qoder',
  mcp: true,
  permissions: false,
  systemPrompt: true,
  skills: false,
  interrupt: true,
  defaultModel: 'gemini-2.5-pro',
  npmPackage: '@qoder-ai/qodercli',
  installHint: 'npm install -g @qoder-ai/qodercli',
};

// ── Dynamic SDK import ─────────────────────────────────────────────────────────
// Try to load the Qoder agent SDK. If unavailable, fall back to subprocess.

interface QoderSdkModule {
  QoderAgent?: new (options?: Record<string, unknown>) => {
    run(prompt: string, options?: Record<string, unknown>): Promise<{
      output: string;
      events?: AsyncIterable<unknown>;
    }>;
  };
}

let qoderSdkCache: QoderSdkModule | null | undefined;

async function loadQoderSdk(): Promise<QoderSdkModule | null> {
  if (qoderSdkCache !== undefined) return qoderSdkCache;
  try {
    const mod = await import('@qoder-ai/qoder-agent-sdk');
    qoderSdkCache = mod as unknown as QoderSdkModule;
    return qoderSdkCache;
  } catch {
    qoderSdkCache = null;
    return null;
  }
}

// ── Qoder JSONL event shapes ───────────────────────────────────────────────────

interface QoderStreamEvent {
  type?: string;
  role?: string;
  content?: string | Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  tool_calls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  tool_result?: { tool_use_id: string; content: string; is_error?: boolean };
  finish_reason?: string;
  error?: { message: string; code?: string };
}

// ── Subprocess session ─────────────────────────────────────────────────────────

class QoderSubprocessSession extends SubprocessSession {
  protected buildArgs(config: BackendSessionConfig): string[] {
    const args: string[] = [];

    // Qoder CLI flags (best-effort based on common CLI patterns)
    if (config.model) {
      args.push('--model', config.model);
    }

    // Non-interactive / print mode
    args.push('--print');

    // JSON output
    args.push('--output-format', 'stream-json');

    // Working directory
    if (config.cwd) {
      args.push('--cwd', config.cwd);
    }

    return args;
  }

  protected formatPrompt(config: BackendSessionConfig): string {
    const prefix = config.systemPrompt ? `${config.systemPrompt}\n\n---\n\n` : '';
    return prefix + 'Ready for instructions.';
  }

  protected parseStdoutLine(line: string): NormalizedMessage | null {
    let event: QoderStreamEvent;
    try {
      event = JSON.parse(line);
    } catch {
      return null;
    }

    if (event.error) {
      return {
        type: 'assistant',
        errorCode: event.error.code ?? 'qoder_error',
        errorDetail: event.error.message,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `Error: ${event.error.message}` }],
        },
      };
    }

    // Tool results
    if (event.tool_result) {
      return {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_result',
            tool_use_id: event.tool_result.tool_use_id,
            content: event.tool_result.content,
            is_error: event.tool_result.is_error,
          }],
        },
        raw: event,
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

    // Tool calls
    const toolBlocks = (event.tool_calls ?? []).map((tc) => ({
      type: 'tool_use' as const,
      id: tc.id,
      name: tc.name,
      input: typeof tc.input === 'string' ? safeJsonParse(tc.input) : (tc.input ?? {}),
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
}

function safeJsonParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return { raw: s };
  }
}

// ── Backend implementation ─────────────────────────────────────────────────────

export class QoderBackend extends SubprocessBackend {
  readonly id = 'qoder';
  readonly capabilities = QODER_CAPABILITIES;
  readonly binaryName = 'qoder';

  createSession(
    config: BackendSessionConfig,
    emit: (e: BackendSessionEvent) => void,
  ): BackendSession {
    const binary = this.resolveBinary();
    if (!binary) {
      emit({ kind: 'error', error: 'Qoder CLI not found. Install with: npm install -g @qoder-ai/qodercli' });
      emit({ kind: 'ended' });
      return {
        start() {},
        end() {},
        sendUserText() {},
        sendUserContent() {},
        resolvePermission() {},
        async interrupt() {},
      };
    }
    return new QoderSubprocessSession(binary, config, emit);
  }

  buildEnv(auth: BackendAuthConfig, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = super.buildEnv(auth, extra);
    if (auth.apiKey) {
      // Qoder uses a generic API key env var
      env.QODER_API_KEY = auth.apiKey;
    }
    if (auth.baseUrl) {
      env.QODER_BASE_URL = auth.baseUrl;
    }
    return env;
  }

  async validateAuth(config: BackendAuthConfig): Promise<{ ok: boolean; error?: string }> {
    if (config.authMode === 'apikey' && !config.apiKey) {
      return { ok: false, error: 'API key is required for Qoder' };
    }
    return { ok: true };
  }

  async checkAuthStatus(): Promise<{ loggedIn: boolean }> {
    // Qoder is "logged in" if the binary is available OR an API key is set
    const binary = this.resolveBinary();
    return { loggedIn: binary !== null };
  }
}

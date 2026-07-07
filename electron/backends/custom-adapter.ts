// custom-adapter.ts — Generic CLI backend adapter for user-defined CLIs.
//
// Allows users to add their own CLI backends with custom:
// - Display name
// - Binary name
// - API key environment variable
// - Base URL environment variable
// - Auth mode (apikey / oauth / none)
//
// The adapter spawns the CLI as a subprocess and communicates via stdin/stdout
// JSONL, similar to SubprocessBackend. Users must ensure their CLI outputs
// compatible JSONL events.

import {
  SubprocessBackend,
  SubprocessSession,
} from './subprocess-backend.js';
import type {
  BackendSession,
  BackendSessionConfig,
  BackendSessionEvent,
  BackendAuthConfig,
  BackendCapabilities,
  NormalizedMessage,
} from './cli-backend.js';

export interface CustomBackendOptions {
  id: string;
  displayName: string;
  binaryName: string;
  apiKeyEnv?: string;      // e.g. "OPENAI_API_KEY"
  baseUrlEnv?: string;     // e.g. "OPENAI_BASE_URL"
  defaultModel?: string;
  installHint?: string;
  npmPackage?: string;
}

// ── Generic JSONL event parser ──────────────────────────────────────────────────
// Tries to parse common event shapes. Users should ensure their CLI outputs
// compatible JSONL.

interface GenericStreamEvent {
  type?: string;
  role?: string;
  content?: string | Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  tool_calls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  tool_result?: { tool_use_id: string; content: string; is_error?: boolean };
  finish_reason?: string;
  error?: { message: string; code?: string };
}

function safeJsonParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return { raw: s };
  }
}

// ── Subprocess session ─────────────────────────────────────────────────────────

class CustomSubprocessSession extends SubprocessSession {
  protected buildArgs(config: BackendSessionConfig): string[] {
    const args: string[] = [];

    // Generic flags — users can customize via their CLI's own config
    if (config.model) {
      args.push('--model', config.model);
    }

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
    let event: GenericStreamEvent;
    try {
      event = JSON.parse(line);
    } catch {
      return null;
    }

    if (event.error) {
      return {
        type: 'assistant',
        errorCode: event.error.code ?? 'custom_error',
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

// ── Backend implementation ─────────────────────────────────────────────────────

export class CustomBackend extends SubprocessBackend {
  readonly id: string;
  readonly capabilities: BackendCapabilities;
  readonly binaryName: string;
  private apiKeyEnv: string;
  private baseUrlEnv: string;

  constructor(options: CustomBackendOptions) {
    super();
    this.id = options.id;
    this.binaryName = options.binaryName;
    this.apiKeyEnv = options.apiKeyEnv ?? 'API_KEY';
    this.baseUrlEnv = options.baseUrlEnv ?? 'BASE_URL';

    this.capabilities = {
      displayName: options.displayName,
      iconId: 'custom',
      mcp: false,
      permissions: false,
      systemPrompt: true,
      skills: false,
      interrupt: true,
      defaultModel: options.defaultModel ?? 'default',
      installHint: options.installHint,
      npmPackage: options.npmPackage,
    };
  }

  createSession(
    config: BackendSessionConfig,
    emit: (e: BackendSessionEvent) => void,
  ): BackendSession {
    const binary = this.resolveBinary();
    if (!binary) {
      emit({
        kind: 'error',
        error: `${this.capabilities.displayName} CLI not found. ${this.capabilities.installHint ?? `Install ${this.binaryName} and ensure it's in your PATH.`}`,
      });
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
    return new CustomSubprocessSession(binary, config, emit);
  }

  buildEnv(auth: BackendAuthConfig, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = super.buildEnv(auth, extra);
    if (auth.apiKey) {
      env[this.apiKeyEnv] = auth.apiKey;
    }
    if (auth.baseUrl) {
      env[this.baseUrlEnv] = auth.baseUrl;
    }
    return env;
  }

  async validateAuth(config: BackendAuthConfig): Promise<{ ok: boolean; error?: string }> {
    if (config.authMode === 'apikey' && !config.apiKey) {
      return { ok: false, error: `${this.apiKeyEnv} is required` };
    }
    return { ok: true };
  }

  async checkAuthStatus(): Promise<{ loggedIn: boolean }> {
    const binary = this.resolveBinary();
    return { loggedIn: binary !== null };
  }
}

// kimi-adapter.ts — Kimi CLI backend adapter (Moonshot AI).
//
// Kimi CLI does not have a JS SDK. It is spawned as a subprocess using the
// print mode (--print) with JSON streaming for both input and output.
//
// Usage:  kimi --print --input-format stream-json --output-format stream-json
//
// Multi-turn: kimi in --print mode with --input-format stream-json reads
// JSONL from stdin continuously, processing each user message and emitting
// responses to stdout. The process stays alive until stdin is closed.
//
// Input format (stdin JSONL):
//   {"role": "user", "content": "Hello"}
//
// Output format (stdout JSONL):
//   {"role": "assistant", "content": "..."}
//   {"role": "assistant", "content": "...", "tool_calls": [...]}
//   {"role": "tool", "tool_call_id": "...", "content": "..."}
//
// Exit codes: 0 = success, 1 = permanent failure, 75 = transient (retry ok).
//
// Auth: via `kimi login` (OAuth) or MOONSHOT_API_KEY environment variable.
//
// Built-in tools: Shell, ReadFile, WriteFile, Grep, Glob, SearchWeb, FetchURL.

import { spawn } from 'node:child_process';
import {
  SubprocessBackend,
  SubprocessSession,
} from './subprocess-backend.js';
import { mergedSubprocessEnv } from '../settings-loader.js';
import type {
  BackendSession,
  BackendSessionConfig,
  BackendSessionEvent,
  BackendAuthConfig,
  BackendCapabilities,
  NormalizedMessage,
  UserContentBlock,
} from './cli-backend.js';

const KIMI_CAPABILITIES: BackendCapabilities = {
  displayName: 'Kimi',
  iconId: 'kimi',
  mcp: false,
  permissions: false,
  systemPrompt: true,
  skills: false,
  interrupt: true,
  defaultModel: 'kimi-latest',
  npmPackage: undefined,
  installHint: process.platform === 'win32'
    ? 'Kimi CLI is not yet available for Windows. Visit https://code.kimi.com for updates.'
    : 'curl -LsSf https://code.kimi.com/install.sh | bash',
};

// ── Kimi JSONL message shapes ─────────────────────────────────────────────────
// See: https://moonshotai.github.io/kimi-cli/en/customization/print-mode.html
// The adapter normalizes them to our NormalizedMessage shape.

interface KimiStreamEvent {
  role?: string;
  content?: string | Array<{ type: string; text?: string }>;
  tool_calls?: Array<{ type: string; id: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  error?: { message: string; code?: string };
}

// ── Session implementation ─────────────────────────────────────────────────────

class KimiSession extends SubprocessSession {
  protected buildArgs(_config: BackendSessionConfig): string[] {
    const args = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
    ];

    if (_config.model && _config.model !== 'kimi-latest') {
      args.push('--model', _config.model);
    }

    // Add working directory
    if (_config.cwd) {
      args.push('--work-dir', _config.cwd);
    }

    return args;
  }

  protected formatPrompt(config: BackendSessionConfig): string {
    // Send the initial prompt as a JSONL user message via stdin.
    // If a system prompt is configured, prepend it to the first message.
    const systemPrefix = config.systemPrompt
      ? `${config.systemPrompt}\n\n---\n\n`
      : '';
    return JSON.stringify({
      role: 'user',
      content: systemPrefix + 'Ready for instructions.',
    });
  }

  protected parseStdoutLine(line: string): NormalizedMessage | null {
    let event: KimiStreamEvent;
    try {
      event = JSON.parse(line);
    } catch {
      // Non-JSON line — skip (could be log output, session resume hint, etc.)
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

    // Tool result events (role: "tool") — emit as tool_result content blocks
    if (event.role === 'tool') {
      return {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_result',
              tool_use_id: event.tool_call_id ?? `tool-${Date.now()}`,
              content: typeof event.content === 'string'
                ? event.content
                : JSON.stringify(event.content ?? ''),
            },
          ],
        },
        raw: event,
      };
    }

    // Only process assistant messages from here
    if (event.role !== 'assistant') return null;

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

    // Skip empty messages (no text and no tool calls)
    if (!text && toolBlocks.length === 0) return null;

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

  sendUserText(text: string): void {
    // Send as JSONL in the unified message format
    this.writeStdin(JSON.stringify({ role: 'user', content: text }));
  }

  sendUserContent(content: UserContentBlock[]): void {
    // Kimi stream-json input supports text and array content
    const textParts: string[] = [];
    let droppedImages = 0;
    for (const b of content) {
      if (b.type === 'text') {
        textParts.push(b.text);
      } else if (b.type === 'image') {
        droppedImages++;
      }
    }
    if (droppedImages > 0) {
      console.warn(`[kimi] sendUserContent dropped ${droppedImages} image(s) — not supported in stream-json mode`);
    }
    if (textParts.length > 0) {
      this.sendUserText(textParts.join('\n'));
    }
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
    // Kimi is logged in if:
    // 1. An API key is set in our config, OR
    // 2. The ~/.kimi directory exists with auth data (OAuth login completed)
    const binary = this.resolveBinary();
    if (!binary) return { loggedIn: false };

    // Check for OAuth login — kimi stores auth data in ~/.kimi/
    const { existsSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    const kimiDir = join(homedir(), '.kimi');
    if (existsSync(kimiDir)) {
      try {
        const files = readdirSync(kimiDir);
        // If the directory has any files, assume auth is configured
        if (files.length > 0) return { loggedIn: true };
      } catch {
        // ignore
      }
    }
    return { loggedIn: false };
  }

  async loginOAuth(): Promise<{ ok: boolean; error?: string }> {
    const binary = this.resolveBinary();
    if (!binary) {
      return { ok: false, error: 'Kimi CLI not found. Install it first.' };
    }
    // OAuth login needs an interactive terminal — launch in Terminal.app on macOS
    if (process.platform === 'darwin') {
      return this.loginInTerminal(binary, ['login']);
    }
    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const env = mergedSubprocessEnv();
      const proc = spawn(binary, ['login'], {
        env,
        stdio: 'inherit',
        detached: true,
      });
      proc.unref();
      proc.on('error', (err: Error) => {
        resolve({ ok: false, error: err.message });
      });
      proc.on('close', (code: number | null) => {
        if (code === 0) {
          resolve({ ok: true });
        } else {
          resolve({ ok: false, error: `kimi login exited with code ${code}` });
        }
      });
    });
  }

  private loginInTerminal(binary: string, args: string[]): Promise<{ ok: boolean; error?: string }> {
    // Just run the binary directly in Terminal — it inherits the user's shell env.
    // No need to dump all env vars as a prefix (that clutters the terminal output).
    const cmd = `${binary} ${args.join(' ')}`;
    const script = `tell application "Terminal"
activate
do script "${cmd.replace(/"/g, '\\\\"')}"
end tell`;
    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const proc = spawn('osascript', ['-e', script], {
        stdio: 'ignore',
      });
      proc.on('error', (err: Error) => {
        resolve({ ok: false, error: err.message });
      });
      proc.on('close', (code: number | null) => {
        if (code === 0) {
          resolve({ ok: true });
        } else {
          resolve({ ok: false, error: `Failed to open Terminal (exit ${code}). Try running "kimi login" manually.` });
        }
      });
    });
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

// codex-adapter.ts — OpenAI Codex CLI backend adapter.
//
// Uses @openai/codex-sdk (TypeScript SDK wrapping the Rust codex CLI).
// The SDK spawns the CLI subprocess internally and exchanges JSONL events
// over stdin/stdout.
//
// SDK API:
//   const codex = new Codex({ apiKey, baseUrl, env });
//   const thread = codex.startThread();
//   const { events } = await thread.runStreamed(prompt, threadOptions);
//
// Events: thread.started, turn.started, turn.completed, turn.failed,
//         item.started, item.updated, item.completed
//
// Items: AgentMessageItem, ReasoningItem, CommandExecutionItem,
//        FileChangeItem, McpToolCallItem, WebSearchItem, TodoListItem,
//        ErrorItem
//
// Auth: apiKey in CodexOptions or OPENAI_API_KEY env var.
//       Also supports `codex auth login` for ChatGPT Plus/Pro OAuth.

import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BackendSession,
  BackendSessionConfig,
  BackendSessionEvent,
  BackendAuthConfig,
  BackendCapabilities,
  CliBackend,
  InputPriority,
  NormalizedMessage,
  UserContentBlock,
  ContentBlock,
} from './cli-backend.js';
import { resolveBinaryFromPath } from './subprocess-backend.js';
import { mergedSubprocessEnv } from '../settings-loader.js';

const CODEX_CAPABILITIES: BackendCapabilities = {
  displayName: 'Codex',
  iconId: 'codex',
  mcp: true,
  permissions: true,
  systemPrompt: true,
  skills: false,
  interrupt: true,
  defaultModel: 'gpt-5.4',
  models: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2'],
  npmPackage: '@openai/codex',
  installHint: 'npm install -g @openai/codex',
};

// ── Dynamic SDK import ─────────────────────────────────────────────────────────
// The SDK may not be installed. Use dynamic import to avoid build failures.

interface CodexSdkThread {
  run(prompt: string, options?: Record<string, unknown>): Promise<{
    finalResponse: string;
    items: unknown[];
  }>;
  runStreamed(prompt: string, options?: Record<string, unknown>): Promise<{
    events: AsyncIterable<CodexThreadEvent>;
  }>;
}

interface CodexSdk {
  new (options?: {
    apiKey?: string;
    baseUrl?: string;
    codexPathOverride?: string;
    env?: Record<string, string>;
    config?: Record<string, unknown>;
  }): {
    startThread(options?: Record<string, unknown>): CodexSdkThread;
  };
}

// Codex thread event types (from events.ts in the SDK)
interface CodexThreadEvent {
  type: string;
  thread_id?: string;
  usage?: { input_tokens: number; output_tokens: number };
  error?: { message: string };
  item?: CodexThreadItem;
}

interface CodexThreadItem {
  id?: string;
  type: string;
  text?: string;
  status?: string;
  command?: string;
  output?: string;
  path?: string;
  diff?: string;
  name?: string;
  arguments?: string;
  result?: string;
  error?: string;
}

let codexSdkCache: CodexSdk | null | undefined;

async function loadCodexSdk(): Promise<CodexSdk | null> {
  if (codexSdkCache !== undefined) return codexSdkCache;
  try {
    const mod = await import('@openai/codex-sdk');
    codexSdkCache = mod.Codex as unknown as CodexSdk;
    return codexSdkCache;
  } catch {
    codexSdkCache = null;
    return null;
  }
}

// ── Session implementation ─────────────────────────────────────────────────────

class CodexSession implements BackendSession {
  private thread: CodexSdkThread | null = null;
  private closed = false;
  private emit: (e: BackendSessionEvent) => void;
  private config: BackendSessionConfig;
  private apiKey?: string;
  private baseUrl?: string;
  private turnQueue: Promise<void> = Promise.resolve();
  private binaryPath: string | null;
  private currentAbort: AbortController | null = null;
  private meetingCommandHandler?: (command: unknown) => Promise<unknown> | unknown;

  constructor(
    binaryPath: string | null,
    config: BackendSessionConfig,
    emit: (e: BackendSessionEvent) => void,
  ) {
    this.binaryPath = binaryPath;
    this.config = config;
    this.emit = emit;
    // Read API key and base URL from config.env where buildEnv placed them
    this.apiKey = config.env?.OPENAI_API_KEY;
    this.baseUrl = config.env?.OPENAI_BASE_URL;
    const handler = config.extra?.meetingCommandHandler;
    if (typeof handler === 'function') {
      this.meetingCommandHandler = handler as (command: unknown) => Promise<unknown> | unknown;
    }
  }

  start(): Promise<void> {
    return this.initAndRun();
  }

  private async initAndRun(): Promise<void> {
    const Codex = await loadCodexSdk();
    if (!Codex) {
      throw new Error('@openai/codex-sdk not installed. Run: npm install @openai/codex-sdk');
    }

    const envStrings: Record<string, string> = {};
    if (this.config.env) {
      for (const [k, v] of Object.entries(this.config.env)) {
        if (typeof v === 'string') envStrings[k] = v;
      }
    }

    try {
      const codex = new Codex({
        codexPathOverride: this.binaryPath ?? undefined,
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
        env: Object.keys(envStrings).length > 0 ? envStrings : undefined,
      });
      this.thread = codex.startThread({
        workingDirectory: this.config.cwd,
        model: this.config.model,
        approvalPolicy: 'untrusted',
        sandboxMode: 'workspace-write',
        skipGitRepoCheck: true,
      });
    } catch (err: unknown) {
      throw new Error(`Codex SDK init failed: ${String(err)}`);
    }

    // Initial prompt: system instructions + "ready" signal
    const systemPrefix = this.config.systemPrompt
      ? `${this.config.systemPrompt}\n\n---\n\n`
      : '';
    const initialPrompt = systemPrefix + 'Ready. Awaiting instructions.';

    try {
      this.currentAbort = new AbortController();
      const { events } = await this.thread.runStreamed(initialPrompt, { signal: this.currentAbort.signal });

      for await (const event of events) {
        if (this.closed) break;
        const msg = this.normalizeEvent(event);
        if (msg) {
          this.emit({ kind: 'message', message: msg });
        }
      }
    } catch (err: unknown) {
      if (!this.closed) {
        this.emit({ kind: 'error', error: `Codex stream error: ${String(err)}` });
      }
      if (!this.closed) throw err;
    } finally {
      this.currentAbort = null;
    }
  }

  private normalizeEvent(event: CodexThreadEvent): NormalizedMessage | null {
    switch (event.type) {
      case 'item.completed':
        return this.normalizeItem(event.item);
      case 'turn.failed':
        return {
          type: 'assistant',
          errorCode: 'codex_turn_failed',
          errorDetail: event.error?.message ?? 'Turn failed',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `Error: ${event.error?.message ?? 'Turn failed'}` }],
          },
        };
      case 'turn.completed':
      case 'turn.started':
      case 'item.started':
      case 'item.updated':
      case 'thread.started':
      default:
        return null;
    }
  }

  private normalizeItem(item?: CodexThreadItem): NormalizedMessage | null {
    if (!item) return null;

    switch (item.type) {
      case 'agent_message':
        this.dispatchMeetingCommands(item.text ?? '');
        return {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: item.text ?? '' }],
          },
          raw: item,
        };

      case 'command_execution':
        return {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: item.id ?? `cmd-${Date.now()}`,
                name: 'Bash',
                input: { command: item.command ?? '' },
              },
              ...(item.output ? [{
                type: 'tool_result' as const,
                tool_use_id: item.id ?? `cmd-${Date.now()}`,
                content: item.output,
              }] : []),
            ],
          },
          raw: item,
        };

      case 'file_change':
        return {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: item.id ?? `file-${Date.now()}`,
                name: 'Write',
                input: { file_path: item.path ?? '', content: item.diff ?? '' },
              },
            ],
          },
          raw: item,
        };

      case 'mcp_tool_call':
        return {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: item.id ?? `mcp-${Date.now()}`,
                name: item.name ?? 'McpTool',
                input: item.arguments ? safeJsonParse(item.arguments) : {},
              },
            ],
          },
          raw: item,
        };

      case 'error':
        return {
          type: 'assistant',
          errorCode: 'codex_item_error',
          errorDetail: item.error ?? 'Item error',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `Error: ${item.error ?? 'Item error'}` }],
          },
        };

      default:
        return null;
    }
  }

  private dispatchMeetingCommands(text: string): void {
    if (!this.meetingCommandHandler) return;
    const fenced = /```meeting-command\s*([\s\S]*?)```/gi;
    for (const match of text.matchAll(fenced)) {
      try {
        const command = JSON.parse(match[1]);
        void Promise.resolve(this.meetingCommandHandler(command)).catch((err) => {
          this.emit({ kind: 'error', error: `Meeting command failed: ${String(err)}` });
        });
      } catch (err) {
        this.emit({ kind: 'error', error: `Invalid meeting-command JSON: ${String(err)}` });
      }
    }
  }

  end(): void {
    this.closed = true;
    this.currentAbort?.abort();
    this.emit({ kind: 'ended' });
    this.emit = () => {};
  }

  sendUserText(text: string, _priority?: InputPriority): void {
    if (!this.thread || this.closed) return;
    const thread = this.thread; // Capture thread reference before async boundary
    // Serialize turns to prevent concurrent runStreamed calls on the same thread
    this.turnQueue = this.turnQueue.then(async () => {
      try {
        const abort = new AbortController();
        this.currentAbort = abort;
        const { events } = await thread.runStreamed(text, { signal: abort.signal });
        for await (const event of events) {
          if (this.closed) break;
          const msg = this.normalizeEvent(event);
          if (msg) this.emit({ kind: 'message', message: msg });
        }
        if (this.currentAbort === abort) this.currentAbort = null;
      } catch (err: unknown) {
        if (!this.closed && !(err instanceof Error && err.name === 'AbortError')) {
          this.emit({ kind: 'error', error: `Codex error: ${String(err)}` });
        }
      }
    }).catch((err: unknown) => {
      // Log instead of silently swallowing — unhandled rejections in the queue
      // chain indicate a bug that should surface, not disappear.
      if (!this.closed) {
        this.emit({ kind: 'error', error: `Codex turn queue error: ${String(err)}` });
      }
    });
  }

  sendUserContent(content: UserContentBlock[], _priority?: InputPriority): void {
    const text = content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const droppedImages = content.filter((b) => b.type === 'image').length;
    if (droppedImages > 0) {
      console.warn(`[codex] sendUserContent dropped ${droppedImages} image(s) — Codex SDK text-only mode`);
    }
    if (text) this.sendUserText(text);
  }

  resolvePermission(_id: string, _decision: 'allow' | 'deny', _message?: string): void {
    // Codex uses approvalPolicy config, not interactive permissions.
  }

  async interrupt(): Promise<void> {
    this.currentAbort?.abort();
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

export class CodexBackend implements CliBackend {
  readonly id = 'codex';
  readonly capabilities = CODEX_CAPABILITIES;

  createSession(
    config: BackendSessionConfig,
    emit: (e: BackendSessionEvent) => void,
  ): BackendSession {
    return new CodexSession(this.resolveBinary(), config, emit);
  }

  resolveBinary(): string | null {
    return resolveCodexRuntime();
  }

  buildEnv(auth: BackendAuthConfig, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = { ...mergedSubprocessEnv(), ...extra };
    if (auth.apiKey) {
      env.OPENAI_API_KEY = auth.apiKey;
    }
    if (auth.baseUrl) {
      env.OPENAI_BASE_URL = auth.baseUrl;
    }
    return env;
  }

  async validateAuth(config: BackendAuthConfig): Promise<{ ok: boolean; error?: string }> {
    if (config.authMode === 'apikey' && !config.apiKey) {
      return { ok: false, error: 'OPENAI_API_KEY is required' };
    }
    return { ok: true };
  }

  async checkAuthStatus(): Promise<{ loggedIn: boolean }> {
    // Codex is logged in if:
    // 1. An API key is set, OR
    // 2. The ~/.codex directory exists with config (OAuth login completed)
    const binary = this.resolveBinary();
    if (!binary) return { loggedIn: false };

    // Check for OAuth login — codex stores config in ~/.codex/
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    const codexDir = join(homedir(), '.codex');
    if (existsSync(join(codexDir, 'config.toml'))) return { loggedIn: true };
    if (existsSync(join(codexDir, 'auth.json'))) return { loggedIn: true };
    // Having the directory itself suggests installation
    return { loggedIn: false };
  }

  async loginOAuth(): Promise<{ ok: boolean; error?: string }> {
    const binary = this.resolveBinary();
    if (!binary) {
      return { ok: false, error: 'Codex CLI not found. Install it first.' };
    }
    // OAuth login needs an interactive terminal — launch in Terminal.app on macOS
    if (process.platform === 'darwin') {
      return this.loginInTerminal(binary, ['auth', 'login']);
    }
    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const env = mergedSubprocessEnv();
      const proc = spawn(binary, ['auth', 'login'], {
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
          resolve({ ok: false, error: `codex auth login exited with code ${code}` });
        }
      });
    });
  }

  private loginInTerminal(binary: string, args: string[]): Promise<{ ok: boolean; error?: string }> {
    // Just run the binary directly in Terminal — it inherits the user's shell env.
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
          resolve({ ok: false, error: `Failed to open Terminal (exit ${code}). Try running "codex auth login" manually.` });
        }
      });
    });
  }
}

/** Resolve an OS-executable Codex path. In a packaged Electron app the SDK is
 * loaded from app.asar, but child_process.spawn cannot execute an ASAR virtual
 * path. electron-builder unpacks the native platform package, so prefer that
 * real path and pass it to the SDK via codexPathOverride. */
export function resolveCodexRuntime(resourcesPath = process.resourcesPath): string | null {
  const platformPackage = process.platform === 'darwin'
    ? `codex-darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
    : process.platform === 'linux'
      ? `codex-linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
      : process.platform === 'win32'
        ? `codex-win32-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
        : null;
  const triple = process.platform === 'darwin'
    ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
    : process.platform === 'linux'
      ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl`
      : process.platform === 'win32'
        ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc`
        : null;
  const binaryName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const candidates: string[] = [];
  if (resourcesPath && platformPackage && triple) {
    candidates.push(join(
      resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      '@openai',
      platformPackage,
      'vendor',
      triple,
      'bin',
      binaryName,
    ));
  }
  const system = resolveBinaryFromPath('codex');
  if (system) candidates.push(system);
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      accessSync(candidate, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
      return realpathSync(candidate);
    } catch { /* try the next runtime */ }
  }
  return null;
}

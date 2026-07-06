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

import { existsSync } from 'node:fs';
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

const CODEX_CAPABILITIES: BackendCapabilities = {
  displayName: 'Codex',
  iconId: 'codex',
  mcp: true,
  permissions: true,
  systemPrompt: true,
  skills: false,
  interrupt: true,
  defaultModel: 'o3-pro',
  models: ['o3-pro', 'o3', 'o4-mini', 'gpt-4.1'],
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
    startThread(): CodexSdkThread;
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

  constructor(
    config: BackendSessionConfig,
    emit: (e: BackendSessionEvent) => void,
  ) {
    this.config = config;
    this.emit = emit;
    // Read API key and base URL from config.env where buildEnv placed them
    this.apiKey = config.env?.OPENAI_API_KEY;
    this.baseUrl = config.env?.OPENAI_BASE_URL;
  }

  start(): void {
    void this.initAndRun();
  }

  private async initAndRun(): Promise<void> {
    const Codex = await loadCodexSdk();
    if (!Codex) {
      this.emit({ kind: 'error', error: '@openai/codex-sdk not installed. Run: npm install @openai/codex-sdk' });
      this.emit({ kind: 'ended' });
      return;
    }

    const envStrings: Record<string, string> = {};
    if (this.config.env) {
      for (const [k, v] of Object.entries(this.config.env)) {
        if (typeof v === 'string') envStrings[k] = v;
      }
    }

    try {
      const codex = new Codex({
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
        env: Object.keys(envStrings).length > 0 ? envStrings : undefined,
      });
      this.thread = codex.startThread();
    } catch (err: unknown) {
      this.emit({ kind: 'error', error: `Codex SDK init failed: ${String(err)}` });
      this.emit({ kind: 'ended' });
      return;
    }

    // Initial prompt: system instructions + "ready" signal
    const systemPrefix = this.config.systemPrompt
      ? `${this.config.systemPrompt}\n\n---\n\n`
      : '';
    const initialPrompt = systemPrefix + 'Ready. Awaiting instructions.';

    try {
      const { events } = await this.thread.runStreamed(initialPrompt, {
        workingDirectory: this.config.cwd,
        model: this.config.model,
        approvalPolicy: 'untrusted',
        sandboxMode: 'workspace-write',
      });

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
    } finally {
      if (!this.closed) {
        this.emit({ kind: 'ended' });
        this.emit = () => {};
      }
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

  end(): void {
    this.closed = true;
    // The Codex SDK doesn't expose a direct kill method on threads.
    // The async iteration will end when the process exits.
  }

  sendUserText(text: string, _priority?: InputPriority): void {
    if (!this.thread || this.closed) return;
    const thread = this.thread; // Capture thread reference before async boundary
    // Serialize turns to prevent concurrent runStreamed calls on the same thread
    this.turnQueue = this.turnQueue.then(async () => {
      try {
        const { events } = await thread.runStreamed(text);
        for await (const event of events) {
          if (this.closed) break;
          const msg = this.normalizeEvent(event);
          if (msg) this.emit({ kind: 'message', message: msg });
        }
      } catch (err: unknown) {
        if (!this.closed) {
          this.emit({ kind: 'error', error: `Codex error: ${String(err)}` });
        }
      }
    }).catch(() => { /* Swallow errors to prevent unhandled rejections in queue */ });
  }

  sendUserContent(content: UserContentBlock[], _priority?: InputPriority): void {
    const text = content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    if (text) this.sendUserText(text);
  }

  resolvePermission(_id: string, _decision: 'allow' | 'deny', _message?: string): void {
    // Codex uses approvalPolicy config, not interactive permissions.
  }

  async interrupt(): Promise<void> {
    // No direct interrupt API in the SDK. End the session.
    this.end();
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
    return new CodexSession(config, emit);
  }

  resolveBinary(): string | null {
    return resolveBinaryFromPath('codex');
  }

  buildEnv(auth: BackendAuthConfig, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = { ...process.env, ...extra };
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

  async loginOAuth(): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: 'Codex uses API key auth. Set your OPENAI_API_KEY.' };
  }
}

// opencode-adapter.ts — OpenCode AI coding agent backend adapter.
//
// Uses @opencode-ai/sdk to spawn an OpenCode server and communicate with it
// via the type-safe client. The server handles session management, message
// streaming, and tool execution internally.
//
// Architecture:
//   AhaMeet main process
//     └── OpenCode server (started by this adapter via createOpencode)
//           └── Sessions (one per meeting participant)
//
// This adapter maps OpenCode's session/message model to the CliBackend
// interface so OpenCode can participate in meetings as a digital employee.

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
} from './cli-backend.js';

// ── SDK types ─────────────────────────────────────────────────────────────────
// Dynamically imported to avoid blocking app startup.

type OpencodeSdk = typeof import('@opencode-ai/sdk');
type OpencodeClient = import('@opencode-ai/sdk').OpencodeClient;

let sdkCache: OpencodeSdk | null | undefined;

async function loadOpencodeSdk(): Promise<OpencodeSdk | null> {
  if (sdkCache !== undefined) return sdkCache;
  try {
    sdkCache = await import('@opencode-ai/sdk');
    return sdkCache;
  } catch {
    sdkCache = null;
    return null;
  }
}

// ── Capabilities ──────────────────────────────────────────────────────────────

const OPENCODE_CAPABILITIES: BackendCapabilities = {
  coordinate: true,
  executeTasks: true,
  displayName: 'OpenCode',
  iconId: 'opencode',
  mcp: true,
  permissions: true,
  systemPrompt: true,
  skills: false,
  interrupt: true,
  defaultModel: 'anthropic/claude-sonnet-4-5',
  models: [
    'anthropic/claude-sonnet-4-5',
    'anthropic/claude-haiku-4-5',
    'openai/gpt-5.4',
    'openai/gpt-5.4-mini',
  ],
  npmPackage: '@opencode-ai/sdk',
  installHint: 'npm install @opencode-ai/sdk',
};

// ── Session implementation ─────────────────────────────────────────────────────

interface OpenCodeServerHandle {
  url: string;
  close(): void;
}

class OpenCodeSession implements BackendSession {
  private server: OpenCodeServerHandle | null = null;
  private client: OpencodeClient | null = null;
  private sessionId: string | null = null;
  private closed = false;
  private eventSource: EventSource | null = null;

  constructor(
    private readonly config: BackendSessionConfig,
    private emit: (event: BackendSessionEvent) => void,
  ) {}

  async start(): Promise<void> {
    const sdk = await loadOpencodeSdk();
    if (!sdk) {
      this.emit({ kind: 'error', error: 'OpenCode SDK not available' });
      return;
    }

    try {
      // Start the OpenCode server
      const { client, server } = await sdk.createOpencode({
        timeout: 30000,
      });
      this.server = server;
      this.client = client;

      // Create a session for this meeting participant
      const sessionResult = await this.client.session.create({
        query: {
          directory: this.config.cwd,
        },
        body: {
          title: `AhaMeet ${this.config.cwd}`,
        },
      });

      if (!sessionResult.data) {
        throw new Error('Failed to create OpenCode session');
      }

      this.sessionId = sessionResult.data.id;

      // Start listening to global events (SSE)
      this.startEventStream();

      this.emit({
        kind: 'message',
        message: {
          type: 'system',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'OpenCode 会话已启动' }],
          },
        },
      });
    } catch (err) {
      this.emit({
        kind: 'error',
        error: `OpenCode start failed: ${String(err)}`,
      });
    }
  }

  private startEventStream(): void {
    if (!this.client || !this.sessionId) return;

    // Use the SDK's SSE endpoint for global events
    // Note: The SDK provides a typed SSE client, but for simplicity we use
    // the raw EventSource here and map events to NormalizedMessage.
    // In a production implementation, we'd use the SDK's typed event stream.
    const url = `${this.server?.url}/global/event`;
    this.eventSource = new EventSource(url);

    this.eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const msg = this.mapEventToMessage(data);
        if (msg) {
          this.emit({ kind: 'message', message: msg });
        }
      } catch (err) {
        console.error('[opencode] event parse error:', err);
      }
    };

    this.eventSource.onerror = (err) => {
      console.error('[opencode] event stream error:', err);
      if (!this.closed) {
        this.emit({ kind: 'error', error: 'OpenCode event stream error' });
      }
    };
  }

  private mapEventToMessage(data: unknown): NormalizedMessage | null {
    // Map OpenCode server events to NormalizedMessage
    // This is a simplified mapping; the actual OpenCode event types should be
    // checked against @opencode-ai/sdk's generated types.
    if (!data || typeof data !== 'object') return null;

    const ev = data as Record<string, unknown>;
    const type = ev.type as string | undefined;

    if (type === 'message.part.updated') {
      const part = ev.part as Record<string, unknown> | undefined;
      if (part && part.type === 'text' && typeof part.text === 'string') {
        return {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: part.text }],
          },
          raw: data,
        };
      }
    }

    return null;
  }

  sendUserText(text: string, _priority?: InputPriority): void {
    if (!this.client || !this.sessionId || this.closed) return;

    void this.client.session.prompt({
      path: { id: this.sessionId },
      body: {
        parts: [{ type: 'text', text }],
      },
    }).catch((err) => {
      this.emit({ kind: 'error', error: `OpenCode prompt failed: ${String(err)}` });
    });
  }

  sendUserContent(content: string | UserContentBlock[], _priority?: InputPriority): void {
    if (typeof content === 'string') {
      this.sendUserText(content);
      return;
    }
    const text = content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    if (text) this.sendUserText(text);
  }

  resolvePermission(_id: string, _decision: 'allow' | 'deny', _message?: string): void {
    // OpenCode handles permissions internally via its own UI/flow
  }

  async interrupt(): Promise<void> {
    if (!this.client || !this.sessionId || this.closed) return;
    try {
      await this.client.session.abort({
        path: { id: this.sessionId },
      });
    } catch (err) {
      console.warn('[opencode] interrupt failed:', err);
    }
  }

  end(): void {
    this.closed = true;
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.sessionId && this.client) {
      void this.client.session.delete({
        path: { id: this.sessionId },
      }).catch(() => {});
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.emit({ kind: 'ended' });
    this.emit = () => {};
  }
}

// ── Backend factory ────────────────────────────────────────────────────────────

export class OpenCodeBackend implements CliBackend {
  readonly id = 'opencode';
  readonly capabilities = OPENCODE_CAPABILITIES;

  createSession(
    config: BackendSessionConfig,
    emit: (e: BackendSessionEvent) => void,
  ): BackendSession {
    return new OpenCodeSession(config, emit);
  }

  resolveBinary(): string | null {
    // OpenCode is bundled as an npm SDK dependency, so it's always available
    // when the app is packaged. Return a sentinel value to indicate SDK mode.
    return 'sdk';
  }

  buildEnv(_auth: BackendAuthConfig, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...process.env, ...extra };
  }

  async validateAuth(config: BackendAuthConfig): Promise<{ ok: boolean; error?: string }> {
    if (config.authMode === 'apikey' && !config.apiKey) {
      return { ok: false, error: 'API key required' };
    }
    return { ok: true };
  }
}

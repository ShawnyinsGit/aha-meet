import { query, type Query, type SDKMessage, type SDKUserMessage, type CanUseTool, type PermissionResult, type Options } from '@anthropic-ai/claude-agent-sdk';
import { mergedSubprocessEnv } from './settings-loader.js';
import { errorMessage } from './format-error.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

function unpackify(p: string): string {
  return p.includes('/app.asar/') ? p.replace('/app.asar/', '/app.asar.unpacked/') : p;
}

function resolveClaudeBinary(): string | undefined {
  const arch = process.arch === 'x64' ? 'darwin-x64' : 'darwin-arm64';
  const subpkg = `@anthropic-ai/claude-agent-sdk-${arch}/claude`;

  // 1. Try resolving from the SDK package's own location (handles nested install).
  try {
    const sdkPkg = require_.resolve('@anthropic-ai/claude-agent-sdk/package.json');
    const sdkRequire = createRequire(sdkPkg);
    const p = unpackify(sdkRequire.resolve(subpkg));
    if (existsSync(p)) return p;
  } catch { /* fall through */ }

  // 2. Try direct resolve from our own context (hoisted install case).
  try {
    const p = unpackify(require_.resolve(subpkg));
    if (existsSync(p)) return p;
  } catch { /* fall through */ }

  // 3. Walk known unpacked-resource paths as a last resort.
  const guesses = [
    process.resourcesPath && `${process.resourcesPath}/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/node_modules/${subpkg}`,
    process.resourcesPath && `${process.resourcesPath}/app.asar.unpacked/node_modules/${subpkg}`,
  ].filter((x): x is string => !!x);
  for (const g of guesses) {
    if (existsSync(g)) return g;
  }
  return undefined;
}

type PermissionPending = {
  resolve: (r: PermissionResult) => void;
  toolName: string;
  input: Record<string, unknown>;
  toolUseID: string;
};

export type SessionEvent =
  | { kind: 'message'; message: SDKMessage }
  | { kind: 'permission-request'; id: string; toolName: string; input: Record<string, unknown>; toolUseID: string }
  | { kind: 'error'; error: string }
  | { kind: 'ended' };

export class ClaudeSession {
  private q: Query | null = null;
  private inputQueue: SDKUserMessage[] = [];
  private inputResolvers: Array<(v: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;
  private pendingPerms = new Map<string, PermissionPending>();
  private emit: (e: SessionEvent) => void;
  private cwd: string;
  private sessionOptions: Partial<Options>;
  private envOverride: NodeJS.ProcessEnv | undefined;
  // Trust-mode flag. When true, canUseTool resolves `allow` immediately and
  // skips emitting a permission-request event, so the worker plows through
  // tool calls without manual approval. Toggled live by the orchestrator.
  // Default OFF — never enabled silently; the user must opt in via the UI.
  private autoApprove = false;

  constructor(opts: {
    emit: (e: SessionEvent) => void;
    cwd: string;
    sessionOptions?: Partial<Options>;
    autoApprove?: boolean;
    /** Process env to feed into the worker subprocess. Overrides
     *  mergedSubprocessEnv() — used to redirect HOME at the merged
     *  bundled+user `.claude` shadow dir. */
    envOverride?: NodeJS.ProcessEnv;
  }) {
    this.emit = opts.emit;
    this.cwd = opts.cwd;
    this.sessionOptions = opts.sessionOptions ?? {};
    this.autoApprove = opts.autoApprove ?? false;
    this.envOverride = opts.envOverride;
  }

  /** Toggle trust-mode live. Affects subsequent canUseTool calls only —
   * any permission requests already pending stay pending until the user
   * (or the orchestrator on session end) resolves them. */
  setAutoApprove(on: boolean) {
    this.autoApprove = on;
  }

  start() {
    if (this.q) return;
    const canUseTool: CanUseTool = (toolName, input, options) => {
      // Trust-mode short-circuit: resolve allow with the original input and
      // intentionally skip emitting `permission-request` so the UI doesn't
      // flicker a pending row that gets answered a tick later. The tool call
      // itself still shows up in the activity feed once the SDK fires it,
      // so there's still an audit trail of what ran.
      if (this.autoApprove) {
        return Promise.resolve<PermissionResult>({ behavior: 'allow', updatedInput: input });
      }
      return new Promise<PermissionResult>((resolve) => {
        const id = randomUUID();
        this.pendingPerms.set(id, { resolve, toolName, input, toolUseID: options.toolUseID });
        this.emit({ kind: 'permission-request', id, toolName, input, toolUseID: options.toolUseID });
      });
    };

    const binPath = resolveClaudeBinary();
    if (!binPath) {
      this.emit({ kind: 'error', error: 'Claude CLI binary not found inside the app bundle. Check app.asar.unpacked.' });
      this.emit({ kind: 'ended' });
      return;
    }
    try {
      this.q = query({
        prompt: this.createInputIterable(),
        options: {
          cwd: this.cwd,
          canUseTool,
          permissionMode: 'default',
          env: this.envOverride ?? mergedSubprocessEnv(),
          includePartialMessages: false,
          pathToClaudeCodeExecutable: binPath,
          // Load user/project/local settings so the worker picks up the
          // developer's installed subagents (~/.claude/agents/*.md), hooks
          // (~/.claude/settings.json → hooks), and MCP servers.
          settingSources: ['user', 'project', 'local'],
          // Skills are NOT auto-enabled by settingSources — omitting `skills`
          // means "CLI defaults apply", which in embedded SDK mode is off.
          // 'all' opts every discovered skill in (both user-level and
          // plugin-qualified). Talker overrides this with `skills: []` since
          // it has no real tools.
          skills: 'all',
          ...this.sessionOptions,
        },
      });
    } catch (err: unknown) {
      this.emit({ kind: 'error', error: `query() init failed: ${errorMessage(err)} (bin=${binPath})` });
      this.emit({ kind: 'ended' });
      return;
    }

    (async () => {
      try {
        for await (const msg of this.q!) {
          if (this.closed) break;
          this.emit({ kind: 'message', message: msg });
        }
      } catch (err: unknown) {
        if (!this.closed) this.emit({ kind: 'error', error: errorMessage(err) });
      } finally {
        this.emit({ kind: 'ended' });
        // Drop the closure-captured emit so any lingering SDK callbacks (e.g.
        // late tool_result, post-interrupt error) can't pollute the next session.
        this.emit = () => {};
      }
    })();
  }

  sendUserText(text: string) {
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    };
    this.pushInput(msg);
  }

  sendUserContent(content: SDKUserMessage['message']['content']) {
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    };
    this.pushInput(msg);
  }

  resolvePermission(id: string, decision: 'allow' | 'deny', message?: string) {
    const pending = this.pendingPerms.get(id);
    if (!pending) return;
    this.pendingPerms.delete(id);
    if (decision === 'allow') {
      pending.resolve({ behavior: 'allow', updatedInput: pending.input });
    } else {
      pending.resolve({ behavior: 'deny', message: message ?? 'User denied this tool call.', interrupt: false });
    }
  }

  async interrupt() {
    if (this.q) {
      try { await this.q.interrupt(); } catch { /* ignore */ }
    }
  }

  async setPermissionMode(mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan') {
    if (this.q) {
      try { await this.q.setPermissionMode(mode); } catch { /* ignore */ }
    }
  }

  end() {
    if (this.closed) return;
    this.closed = true;

    // Resolve any in-flight permission requests as deny+interrupt so the SDK's
    // CanUseTool promise never hangs (which would orphan the subprocess).
    for (const [id, p] of this.pendingPerms) {
      try { p.resolve({ behavior: 'deny', message: 'session ended', interrupt: true }); } catch { /* ignore */ }
      this.pendingPerms.delete(id);
    }

    // Wake up the input iterator so the for-await loop exits.
    while (this.inputResolvers.length > 0) {
      const r = this.inputResolvers.shift();
      r?.({ value: undefined as any, done: true });
    }

    // Tell the SDK to stop streaming. interrupt() is async but we don't await —
    // the for-await loop will exit on its own and the finally clears `emit`.
    if (this.q) {
      this.q.interrupt().catch(() => { /* ignore */ });
    }
  }

  private pushInput(m: SDKUserMessage) {
    if (this.closed) return;
    const r = this.inputResolvers.shift();
    if (r) {
      r({ value: m, done: false });
    } else {
      this.inputQueue.push(m);
    }
  }

  private createInputIterable(): AsyncIterable<SDKUserMessage> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
        return {
          next(): Promise<IteratorResult<SDKUserMessage>> {
            if (self.inputQueue.length > 0) {
              return Promise.resolve({ value: self.inputQueue.shift()!, done: false });
            }
            if (self.closed) {
              return Promise.resolve({ value: undefined as any, done: true });
            }
            return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
              self.inputResolvers.push(resolve);
            });
          },
        };
      },
    };
  }
}

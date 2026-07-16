// kimi-adapter.ts — Kimi Code CLI adapter.
// Kimi 0.24+ is a one-shot CLI. Multi-turn conversations resume by passing
// the session id emitted in the stream's `session.resume_hint` meta event.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, delimiter, join } from 'node:path';
import { SubprocessBackend } from './subprocess-backend.js';
import { mergedSubprocessEnv } from '../settings-loader.js';
import { runTerminalLogin } from './terminal-login.js';
import type {
  BackendSession, BackendSessionConfig, BackendSessionEvent, BackendAuthConfig,
  BackendCapabilities, NormalizedMessage, UserContentBlock, InputPriority,
} from './cli-backend.js';

const KIMI_CAPABILITIES: BackendCapabilities = {
  displayName: 'Kimi', iconId: 'kimi', mcp: false, permissions: false,
  systemPrompt: true, skills: false, interrupt: true,
  defaultModel: 'kimi-latest',
  installHint: process.platform === 'win32'
    ? 'Kimi CLI is not yet available for Windows. Visit https://code.kimi.com for updates.'
    : 'curl -LsSf https://code.kimi.com/install.sh | bash',
};

interface KimiStreamEvent {
  role?: string;
  type?: string;
  session_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
  tool_calls?: Array<{ type: string; id: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  error?: { message: string; code?: string };
}

export function buildKimiCommandArgs(input: {
  prompt: string; model?: string; sessionId?: string;
}): string[] {
  const args: string[] = [];
  if (input.sessionId) args.push('--session', input.sessionId);
  args.push('--prompt', input.prompt, '--output-format', 'stream-json');
  if (input.model && input.model !== 'kimi-latest') args.push('--model', input.model);
  return args;
}

export function parseKimiStreamEvent(line: string): {
  message?: NormalizedMessage; sessionId?: string;
} | null {
  let event: KimiStreamEvent;
  try { event = JSON.parse(line) as KimiStreamEvent; } catch { return null; }
  if (event.role === 'meta' && event.type === 'session.resume_hint' && event.session_id) {
    return { sessionId: event.session_id };
  }
  if (event.error) {
    return { message: {
      type: 'assistant', errorCode: event.error.code ?? 'kimi_error',
      errorDetail: event.error.message,
      message: { role: 'assistant', content: [{ type: 'text', text: `Error: ${event.error.message}` }] },
      raw: event,
    } };
  }
  if (event.role === 'tool') {
    return { message: {
      type: 'assistant',
      message: { role: 'assistant', content: [{
        type: 'tool_result', tool_use_id: event.tool_call_id ?? `tool-${Date.now()}`,
        content: typeof event.content === 'string' ? event.content : JSON.stringify(event.content ?? ''),
      }] }, raw: event,
    } };
  }
  if (event.role !== 'assistant') return null;
  const text = typeof event.content === 'string'
    ? event.content
    : Array.isArray(event.content)
      ? event.content.filter((b) => b.type === 'text' && b.text).map((b) => b.text!).join('')
      : '';
  const tools = (event.tool_calls ?? []).map((tc) => ({
    type: 'tool_use' as const, id: tc.id, name: tc.function.name,
    input: safeJsonParse(tc.function.arguments),
  }));
  if (!text && tools.length === 0) return null;
  return { message: {
    type: 'assistant',
    message: { role: 'assistant', content: [
      ...(text ? [{ type: 'text' as const, text }] : []), ...tools,
    ] }, raw: event,
  } };
}

class KimiSession implements BackendSession {
  private process: ChildProcess | null = null;
  private closed = false;
  private sessionId?: string;
  private queue = Promise.resolve();

  constructor(
    private readonly binary: string,
    private readonly config: BackendSessionConfig,
    private emit: (event: BackendSessionEvent) => void,
  ) {}

  async start(): Promise<void> {
    const prefix = this.config.systemPrompt ? `${this.config.systemPrompt}\n\n---\n\n` : '';
    await this.runTurn(`${prefix}Ready for instructions.`);
  }

  private runTurn(prompt: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const env = this.config.env ?? mergedSubprocessEnv();
      env.PATH = [dirname(this.binary), env.PATH].filter(Boolean).join(delimiter);
      const proc = spawn(this.binary, buildKimiCommandArgs({
        prompt, model: this.config.model, sessionId: this.sessionId,
      }), { cwd: this.config.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.process = proc;
      let stdout = '';
      let stderr = '';
      const consume = (line: string) => {
        const parsed = parseKimiStreamEvent(line.trim());
        if (parsed?.sessionId) this.sessionId = parsed.sessionId;
        if (parsed?.message && !this.closed) this.emit({ kind: 'message', message: parsed.message });
      };
      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        const lines = stdout.split('\n');
        stdout = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) consume(line);
      });
      proc.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-1000); });
      proc.once('error', (error) => {
        if (this.process === proc) this.process = null;
        if (!this.closed) this.emit({ kind: 'error', error: `Kimi 启动失败：${error.message}` });
        reject(error);
      });
      proc.once('close', (code, signal) => {
        if (stdout.trim()) consume(stdout);
        if (this.process === proc) this.process = null;
        if (!this.closed && code !== 0 && signal !== 'SIGINT' && signal !== 'SIGTERM') {
          const detail = stderr.trim() || `exit ${code}`;
          this.emit({ kind: 'error', error: `Kimi 执行失败：${detail}` });
          reject(new Error(detail));
        } else resolve();
      });
    });
  }

  sendUserText(text: string, _priority?: InputPriority): void {
    if (this.closed) return;
    this.queue = this.queue.then(() => this.runTurn(text)).catch(() => undefined);
  }

  sendUserContent(content: string | UserContentBlock[], priority?: InputPriority): void {
    if (typeof content === 'string') return this.sendUserText(content, priority);
    const text = content.filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text).join('\n');
    if (text) this.sendUserText(text, priority);
  }

  resolvePermission(): void {}
  async interrupt(): Promise<void> { this.process?.kill('SIGINT'); }
  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.process?.kill('SIGTERM');
    this.emit({ kind: 'ended' });
    this.emit = () => undefined;
  }
}

function safeJsonParse(value: string): Record<string, unknown> {
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return { raw: value }; }
}

export class KimiBackend extends SubprocessBackend {
  readonly id = 'kimi';
  readonly capabilities = KIMI_CAPABILITIES;
  readonly binaryName = 'kimi';

  createSession(config: BackendSessionConfig, emit: (e: BackendSessionEvent) => void): BackendSession {
    const binary = this.resolveBinary();
    if (!binary) {
      emit({ kind: 'error', error: 'Kimi CLI not found. Install with: curl -LsSf https://code.kimi.com/install.sh | bash' });
      emit({ kind: 'ended' });
      return createNoopSession();
    }
    return new KimiSession(binary, config, emit);
  }

  buildEnv(auth: BackendAuthConfig, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = super.buildEnv(auth, extra);
    if (auth.apiKey) env.MOONSHOT_API_KEY = auth.apiKey;
    if (auth.baseUrl) env.MOONSHOT_BASE_URL = auth.baseUrl;
    return env;
  }

  async validateAuth(config: BackendAuthConfig): Promise<{ ok: boolean; error?: string }> {
    return config.authMode === 'apikey' && !config.apiKey
      ? { ok: false, error: 'MOONSHOT_API_KEY is required' } : { ok: true };
  }

  async checkAuthStatus(): Promise<{ loggedIn: boolean }> {
    if (!this.resolveBinary()) return { loggedIn: false };
    return { loggedIn: existsSync(join(homedir(), '.kimi-code', 'credentials', 'kimi-code.json')) };
  }

  async loginOAuth(): Promise<{ ok: boolean; error?: string }> {
    const binary = this.resolveBinary();
    if (!binary) return { ok: false, error: 'Kimi CLI not found. Install it first.' };
    return runTerminalLogin(binary, ['login'], () => this.checkAuthStatus());
  }
}


function createNoopSession(): BackendSession {
  return { start() {}, end() {}, sendUserText() {}, sendUserContent() {}, resolvePermission() {}, async interrupt() {} };
}

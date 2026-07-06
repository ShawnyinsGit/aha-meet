// subprocess-backend.ts — abstract base class for CLI backends that don't
// have a JavaScript SDK. Spawns the CLI binary as a child process,
// communicates via stdin (JSON prompts) and parses stdout (JSONL events).
//
// Concrete adapters (Kimi, future CLIs) extend this class and implement:
//   • buildArgs(config) — CLI arguments for spawning
//   • parseStdoutLine(line) — convert a JSONL line to NormalizedMessage
//   • formatPrompt(config) — format the initial prompt for the CLI
//
// The base class handles:
//   • Process lifecycle (spawn, kill, cleanup)
//   • Stdin/stdout/stderr piping
//   • Exit code handling (0=success, non-zero=error)
//   • stderr ring buffer for error diagnostics

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter } from 'node:path';
import {
  type BackendSession,
  type BackendSessionConfig,
  type BackendSessionEvent,
  type BackendAuthConfig,
  type BackendCapabilities,
  type CliBackend,
  type InputPriority,
  type NormalizedMessage,
  type UserContentBlock,
} from './cli-backend.js';

// ── Subprocess session ────────────────────────────────────────────────────────
// Controls a spawned CLI process. Sends prompts via stdin, reads JSONL from
// stdout, captures stderr for diagnostics.

export abstract class SubprocessSession implements BackendSession {
  protected process: ChildProcess | null = null;
  protected stderrRing: string[] = [];
  protected closed = false;
  protected emit: (e: BackendSessionEvent) => void;
  protected config: BackendSessionConfig;
  protected binaryPath: string;

  constructor(
    binaryPath: string,
    config: BackendSessionConfig,
    emit: (e: BackendSessionEvent) => void,
  ) {
    this.binaryPath = binaryPath;
    this.config = config;
    this.emit = emit;
  }

  /** Subclasses implement: build CLI arguments for spawning. */
  protected abstract buildArgs(config: BackendSessionConfig): string[];

  /** Subclasses implement: parse one stdout line into a NormalizedMessage. */
  protected abstract parseStdoutLine(line: string): NormalizedMessage | null;

  /** Subclasses implement: format the initial prompt string. */
  protected abstract formatPrompt(config: BackendSessionConfig): string;

  start(): void {
    if (this.process || this.closed) return;

    const args = this.buildArgs(this.config);
    try {
      this.process = spawn(this.binaryPath, args, {
        cwd: this.config.cwd,
        env: this.config.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      this.emit({ kind: 'error', error: `Failed to spawn ${this.binaryPath}: ${String(err)}` });
      this.emit({ kind: 'ended' });
      return;
    }

    // stdout: JSONL line-by-line
    let buffer = '';
    this.process.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = this.parseStdoutLine(trimmed);
          if (msg) {
            this.emit({ kind: 'message', message: msg });
          }
        } catch (err) {
          console.warn('[subprocess-backend] parseStdoutLine failed:', trimmed.slice(0, 200), err);
        }
      }
    });

    // stderr: diagnostic ring buffer
    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      this.stderrRing.push(text);
      if (this.stderrRing.length > 40) this.stderrRing.shift();
      console.error(`[subprocess-backend:${this.binaryPath}:stderr]`, text.trim());
    });

    // Exit handling
    this.process.on('close', (code: number | null, signal: string | null) => {
      // Flush remaining buffer
      if (buffer.trim()) {
        try {
          const msg = this.parseStdoutLine(buffer.trim());
          if (msg) this.emit({ kind: 'message', message: msg });
        } catch { /* ignore */ }
      }

      if (!this.closed) {
        if (code !== null && code !== 0) {
          const stderrTail = this.stderrRing.join('').slice(-2000).trim();
          this.emit({
            kind: 'error',
            error: `${this.binaryPath} exited with code ${code}${stderrTail ? `: ${stderrTail}` : ''}`,
          });
        }
        this.emit({ kind: 'ended' });
        this.emit = () => {};
      }
      this.process = null;
    });

    this.process.on('error', (err: Error) => {
      if (!this.closed) {
        this.emit({ kind: 'error', error: `${this.binaryPath} process error: ${err.message}` });
        this.emit({ kind: 'ended' });
        this.emit = () => {};
      }
      this.process = null;
    });

    // Send the initial prompt via stdin
    const prompt = this.formatPrompt(this.config);
    this.writeStdin(prompt);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.process) {
      try {
        this.process.kill('SIGTERM');
        // Give it 2 seconds, then force kill
        const killTimer = setTimeout(() => {
          if (this.process) {
            try { this.process.kill('SIGKILL'); } catch { /* ignore */ }
          }
        }, 2000);
        this.process.once('close', () => clearTimeout(killTimer));
      } catch { /* ignore */ }
    }
  }

  sendUserText(text: string, _priority?: InputPriority): void {
    // For subprocess-based backends, subsequent user messages are sent via
    // stdin. Not all CLIs support this — override in subclass if needed.
    this.writeStdin(text);
  }

  sendUserContent(content: UserContentBlock[], _priority?: InputPriority): void {
    // Extract text from content blocks; images are not supported by most
    // subprocess CLIs.
    const text = content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    if (text) this.sendUserText(text);
  }

  resolvePermission(_id: string, _decision: 'allow' | 'deny', _message?: string): void {
    // Subprocess CLIs typically don't support interactive permission flow.
    // Override in subclass if the CLI has a permission protocol.
  }

  async interrupt(): Promise<void> {
    if (this.process && !this.closed) {
      try { this.process.kill('SIGINT'); } catch { /* ignore */ }
    }
  }

  protected writeStdin(data: string): void {
    if (this.process?.stdin?.writable) {
      this.process.stdin.write(data + '\n');
    }
  }
}

// ── Subprocess backend base class ──────────────────────────────────────────────
// Extends CliBackend for CLIs that are spawned as subprocesses.

export abstract class SubprocessBackend implements CliBackend {
  abstract readonly id: string;
  abstract readonly capabilities: BackendCapabilities;
  /** Name of the CLI binary (e.g. 'kimi', 'codex'). Used for PATH lookup. */
  abstract readonly binaryName: string;

  /** Subclasses implement: create the session instance. */
  abstract createSession(
    config: BackendSessionConfig,
    emit: (e: BackendSessionEvent) => void,
  ): BackendSession;

  resolveBinary(): string | null {
    return resolveBinaryFromPath(this.binaryName);
  }

  buildEnv(auth: BackendAuthConfig, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...process.env, ...extra };
  }
}

// ── Binary resolution from PATH ────────────────────────────────────────────────
// Tries to find a binary by name: system PATH first, then known locations.

export function resolveBinaryFromPath(binaryName: string): string | null {
  // 1. Check system PATH via `which`
  try {
    const { execSync } = require('node:child_process');
    const result = execSync(`which ${binaryName} 2>/dev/null`, { encoding: 'utf8', timeout: 3000 });
    const path = result.trim();
    if (path && existsSync(path)) return path;
  } catch { /* not found in PATH */ }

  // 2. Known install locations
  const home = process.env.HOME ?? '';
  const candidates = [
    `/usr/local/bin/${binaryName}`,
    `/opt/homebrew/bin/${binaryName}`,
    `${home}/.local/bin/${binaryName}`,
    `${home}/.bin/${binaryName}`,
    `${home}/bin/${binaryName}`,
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  // 3. Windows .exe variants
  if (process.platform === 'win32') {
    const winCandidates = [
      `C:\\Program Files\\${binaryName}\\${binaryName}.exe`,
      `${process.env.LOCALAPPDATA}\\${binaryName}\\${binaryName}.exe`,
      `${process.env.APPDATA}\\npm\\${binaryName}.cmd`,
    ];
    for (const candidate of winCandidates) {
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

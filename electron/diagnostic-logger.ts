import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const SECRET_PATTERN = /(sk-[a-zA-Z0-9_-]{10,}|bearer\s+[a-zA-Z0-9._-]+)/gi;

function redact(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(SECRET_PATTERN, '[REDACTED]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      /token|secret|key|authorization/i.test(key) ? '[REDACTED]' : redact(child),
    ]));
  }
  return value;
}

export class DiagnosticLogger {
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly meetingId: string) {}

  log(type: string, fields: Record<string, unknown>): void {
    const entry = { ts: new Date().toISOString(), type, ...redact(fields) as Record<string, unknown> };
    this.tail = this.tail.then(async () => {
      const dir = join(app.getPath('userData'), 'meetings', this.meetingId, 'diagnostics');
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.appendFile(join(dir, 'launch.jsonl'), `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    }).catch(() => {});
  }
}

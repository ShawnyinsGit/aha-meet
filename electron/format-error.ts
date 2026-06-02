export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const msg = (error as { message: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// Patterns that match credential material we must never surface in logs, the
// renderer, or the UI. Covers Anthropic-style keys, bearer tokens, and the
// generic `header/field: value` form (catches arbitrary gateway keys whose
// value format we can't predict, e.g. a bare hex key behind x-api-key).
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/gi,
  /(bearer\s+)[A-Za-z0-9._-]{8,}/gi,
];
const SECRET_FIELD_RE =
  /((?:x-api-key|anthropic-api-key|api[_-]?key|authorization)["']?\s*[:=]\s*)(["']?)[^\s"',}\]]{4,}/gi;

export function redactSecrets(input: string): string {
  if (!input) return input;
  let out = input;
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, '[REDACTED]');
  out = out.replace(SECRET_FIELD_RE, '$1$2[REDACTED]');
  return out;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const msg = (error as { message: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  return String(error);
}

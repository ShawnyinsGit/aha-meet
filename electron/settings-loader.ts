import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getSettings } from './store.js';

export interface ClaudeEnv {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  [k: string]: string | undefined;
}

export function loadClaudeEnv(): ClaudeEnv {
  const path = join(homedir(), '.claude', 'settings.json');
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    const env = (parsed?.env ?? {}) as ClaudeEnv;
    return env;
  } catch {
    return {};
  }
}

// Whitelist of env vars we forward from the Electron main process into the
// Claude SDK subprocess. The old code did `{ ...process.env }`, which leaked
// every credential the user happened to have exported in their shell rc
// (AWS_*, GITHUB_TOKEN, OpenAI keys, DATABASE_URL, …) into a process that
// talks to a remote LLM and can shell out arbitrary commands. Anything not
// listed here gets dropped; Anthropic credentials still come from
// ~/.claude/settings.json or app settings below.
const ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  // Process essentials
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TEMP',
  'TMP',
  // Locale
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LANGUAGE',
  // TTY
  'TERM',
  'COLORTERM',
  // TLS roots — corporate MITM proxies need NODE_EXTRA_CA_CERTS / SSL_CERT_FILE
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  // Outbound proxy (both casings — some tools only read one)
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  // Node runtime knobs the SDK or its deps may honor
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_TLS_REJECT_UNAUTHORIZED',
]);

// Prefix allowlist — forward anything starting with these. ANTHROPIC_* covers
// API_KEY/BASE_URL/AUTH_TOKEN/MODEL/etc.; CLAUDE_* covers internal Claude
// Code envs like CLAUDE_PROJECT_DIR; XDG_* lets Claude Code find non-default
// config dirs.
const ENV_PREFIX_ALLOWLIST: readonly string[] = ['ANTHROPIC_', 'CLAUDE_', 'XDG_'];

function isEnvAllowed(name: string): boolean {
  if (ENV_ALLOWLIST.has(name)) return true;
  for (const pfx of ENV_PREFIX_ALLOWLIST) {
    if (name.startsWith(pfx)) return true;
  }
  return false;
}

export function mergedSubprocessEnv(): NodeJS.ProcessEnv {
  const claudeEnv = loadClaudeEnv();
  const out: NodeJS.ProcessEnv = {};
  // 1. Inherit only allowlisted vars from the Electron main process env.
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && isEnvAllowed(k)) out[k] = v;
  }
  // 2. Overlay ~/.claude/settings.json env. User explicitly authored that
  //    file, so we trust every key in it (and let it override allowlisted
  //    process env where they collide).
  for (const [k, v] of Object.entries(claudeEnv)) {
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  // 3. App settings: explicit API key entered in the UI wins over everything.
  const appSettings = getSettings();
  if (appSettings.authMode === 'apikey' && appSettings.anthropicApiKey) {
    out['ANTHROPIC_API_KEY'] = appSettings.anthropicApiKey;
  }
  return out;
}

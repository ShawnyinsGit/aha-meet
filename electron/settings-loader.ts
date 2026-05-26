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

export function mergedSubprocessEnv(): NodeJS.ProcessEnv {
  const claudeEnv = loadClaudeEnv();
  const out: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(claudeEnv)) {
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  // User-configured API key from app settings takes priority over everything
  // else (overrides ~/.claude/settings.json and the inherited process env).
  const appSettings = getSettings();
  if (appSettings.authMode === 'apikey' && appSettings.anthropicApiKey) {
    out['ANTHROPIC_API_KEY'] = appSettings.anthropicApiKey;
  }
  return out;
}

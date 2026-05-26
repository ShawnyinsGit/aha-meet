// store.ts — tiny JSON settings store backed by userData/settings.json.
//
// Used for things that should survive app restarts but aren't worth a full DB:
// last working directory, voice-print enrollment, voice-lock toggle, etc.
//
// Reads are synchronous and cached after first hit. Writes go through an
// atomic temp+rename so a crash mid-write won't leave a half-truncated file.

import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface VoicePrint {
  // Float32 embedding flattened into a regular number[] for JSON.
  embedding: number[];
  // Model identifier so we can invalidate enrollments when the model changes.
  model: string;
  // Seconds of speech the enrollment was averaged over (UI feedback).
  secondsCaptured: number;
  enrolledAt: number;
}

export interface Settings {
  lastCwd?: string;
  voiceLockEnabled?: boolean;
  voicePrint?: VoicePrint;
  // null = "auto" (let rankVoice pick). A string overrides the picker with
  // the user's explicit choice; we match by SpeechSynthesisVoice.name.
  selectedVoiceName?: string | null;
  // Once the user dismisses the one-shot "go download Siri voices" guide
  // with "don't show again", we stop nagging — even if they later remove
  // the premium voices, they made their choice.
  voiceGuidanceDismissed?: boolean;
  // TTS noise filter: 'strict' drops English-only sentences and worker
  // tool-call narration before playback (default); 'off' speaks raw.
  speechFilterMode?: 'strict' | 'off';
  // Claude authentication: 'apikey' uses a manually-entered API key;
  // 'subscription' relies on the claude CLI's own OAuth credentials.
  authMode?: 'apikey' | 'subscription';
  // Manually entered Anthropic API key. Only used when authMode === 'apikey'.
  // Stored as plain text in the settings file (userData/settings.json).
  anthropicApiKey?: string;
}

let cached: Settings | null = null;
let cachedPath: string | null = null;

function settingsPath(): string {
  if (cachedPath) return cachedPath;
  cachedPath = join(app.getPath('userData'), 'settings.json');
  return cachedPath;
}

function load(): Settings {
  if (cached) return cached;
  const p = settingsPath();
  if (!existsSync(p)) {
    cached = {};
    return cached;
  }
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    cached = typeof parsed === 'object' && parsed !== null ? (parsed as Settings) : {};
  } catch (err) {
    // Corrupt file — log and start fresh rather than crash the app.
    console.error('[store] failed to parse settings.json, starting fresh:', err);
    cached = {};
  }
  return cached;
}

function persist(next: Settings): void {
  const p = settingsPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  renameSync(tmp, p);
  cached = next;
}

export function getSettings(): Settings {
  return { ...load() };
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = { ...load(), ...patch };
  persist(next);
  return { ...next };
}

export function clearVoicePrint(): Settings {
  const current = load();
  const { voicePrint: _vp, ...rest } = current;
  persist(rest);
  return { ...rest };
}

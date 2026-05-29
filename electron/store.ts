// store.ts — tiny JSON settings store backed by userData/settings.json.
//
// Used for things that should survive app restarts but aren't worth a full DB:
// recent cwds for the Lobby, open tab list for cold-restart, voice-print
// enrollment, voice-lock toggle, etc.
//
// Reads stay synchronous (cache hit after first load) so call sites that just
// need to look up `selectedVoiceName` etc. don't have to thread async through
// the world.
//
// Writes are async + atomic (`fs.promises.writeFile` to a temp file +
// `fs.promises.rename`). All writes are funneled through a single tail-promise
// queue so two concurrent updates can't race on the rename — same pattern as
// memory.ts. Use `flushSettingsWrites()` on shutdown to wait for the queue
// to drain so `before-quit` can't return before the last openTabs snapshot
// hits disk.

import { app } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
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

export interface RecentCwdEntry {
  path: string;
  lastOpenedAt: number;
}

export interface OpenTabEntry {
  cwd: string;
  openedAt: number;
}

export interface Settings {
  /** @deprecated Migrated into recentCwds + lastActiveCwd at first load. Kept
   *  in the type so JSON files written by old versions parse without warnings. */
  lastCwd?: string;
  /** LRU of directories the user has ever opened a meeting in. Newest first.
   *  Capped at RECENT_CWDS_MAX to keep settings.json bounded. */
  recentCwds?: RecentCwdEntry[];
  /** Tabs that were open last time the app quit. The renderer uses this on
   *  cold start to draw placeholder tabs without spawning Orchestrators. */
  openTabs?: OpenTabEntry[];
  /** The cwd of the focused tab at last quit, so cold restart can auto-focus
   *  the right placeholder. */
  lastActiveCwd?: string | null;
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

const RECENT_CWDS_MAX = 10;

let cached: Settings | null = null;
let cachedPath: string | null = null;

// Single tail-promise chain; mirrors the pattern in memory.ts. Errors are
// swallowed locally so one bad write doesn't poison the chain — individual
// write functions still get the original rejection via `next`.
let writeQueue: Promise<unknown> = Promise.resolve();

function withWriteLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = writeQueue.then(() => fn());
  writeQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** Resolves once the in-flight write queue has drained. Call from
 *  `before-quit` so the last openTabs snapshot is on disk before exit. */
export function flushSettingsWrites(): Promise<void> {
  return writeQueue.then(
    () => undefined,
    () => undefined,
  );
}

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
  // One-shot migration: pre-multi-tab versions only kept lastCwd. Promote it
  // into recentCwds so the Lobby has something to show, then drop the field
  // (recentCwds + lastActiveCwd subsume it). Idempotent: if recentCwds is
  // already populated the migration is a no-op. Fire-and-forget the persist
  // — `load()` callers don't want to await migration on every cache miss.
  if (cached.lastCwd && (!cached.recentCwds || cached.recentCwds.length === 0)) {
    const migrated: Settings = {
      ...cached,
      recentCwds: [{ path: cached.lastCwd, lastOpenedAt: Date.now() }],
      lastActiveCwd: cached.lastCwd,
    };
    delete migrated.lastCwd;
    cached = migrated;
    void persist(migrated).catch((err) => {
      console.error('[store] migration write failed:', err);
    });
  }
  return cached;
}

async function persist(next: Settings): Promise<void> {
  const p = settingsPath();
  await fsp.mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  await fsp.rename(tmp, p);
  // Cache flips only after the rename succeeds — if write/rename throws we
  // keep the prior cache so the rest of the app sees a coherent value.
  cached = next;
}

export function getSettings(): Settings {
  return { ...load() };
}

export function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  return withWriteLock(async () => {
    const next = { ...load(), ...patch };
    await persist(next);
    return { ...next };
  });
}

export function clearVoicePrint(): Promise<Settings> {
  return withWriteLock(async () => {
    const current = load();
    const { voicePrint: _vp, ...rest } = current;
    await persist(rest);
    return { ...rest };
  });
}

/** Upsert a cwd into the LRU. Bumps existing entries to the top instead of
 *  duplicating. Cap at RECENT_CWDS_MAX to keep the file bounded — only the
 *  Lobby renders this list, no one needs an unbounded scroll. */
export function pushRecentCwd(cwd: string): Promise<Settings> {
  return withWriteLock(async () => {
    const current = load();
    const now = Date.now();
    const existing = (current.recentCwds ?? []).filter((r) => r.path !== cwd);
    const next: Settings = {
      ...current,
      recentCwds: [{ path: cwd, lastOpenedAt: now }, ...existing].slice(0, RECENT_CWDS_MAX),
    };
    await persist(next);
    return { ...next };
  });
}

/** Replace the openTabs + lastActiveCwd atomically. Called on every tab
 *  open/close/setActive so a sudden quit still restores accurately. */
export function setOpenTabs(tabs: OpenTabEntry[], activeCwd: string | null): Promise<Settings> {
  return withWriteLock(async () => {
    const current = load();
    const next: Settings = {
      ...current,
      openTabs: tabs.map((t) => ({ cwd: t.cwd, openedAt: t.openedAt })),
      lastActiveCwd: activeCwd,
    };
    await persist(next);
    return { ...next };
  });
}

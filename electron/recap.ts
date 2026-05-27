// recap.ts — best-effort end-of-meeting recap pass.
//
// Run once after the user leaves a meeting. Feeds the talker transcript to
// a Haiku query with no tools / no MCP, asks for a JSON array of memorable
// items, then funnels parsed items through the same `appendEntry` validation
// (secret patterns, length caps) used by the live save_memory tool path.
//
// Returns a handle so the orchestrator can abort the recap if the user
// presses interrupt after `end()` was called.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { appendEntry } from './memory.js';
import { extractText, RECAP_MIN_TRANSCRIPT_ENTRIES, RECAP_TRANSCRIPT_CHAR_CAP } from './orchestrator-helpers.js';
import { RECAP_PROMPT } from './orchestrator-prompts.js';
import { mergedSubprocessEnv } from './settings-loader.js';
import type { MemoryCategory } from './memory.js';
import type { TalkerTurn } from './orchestrator-types.js';

export interface RecapOpts {
  transcript: TalkerTurn[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  projectId: string;
  meetingId: string;
}

export interface RecapHandle {
  /** Resolves when the recap finishes (success, abort, or failure). Never
   *  rejects — all errors are logged and swallowed so callers can `void` it. */
  done: Promise<void>;
  /** Cancel an in-flight recap. Safe to call multiple times. */
  abort: () => Promise<void>;
  /** True until the recap promise resolves. */
  isActive: () => boolean;
}

const RECAP_CATEGORIES: ReadonlySet<MemoryCategory> = new Set([
  'point',
  'decision',
  'todo',
  'fact',
]);

/** Kick off a recap pass. Returns null if the transcript is too short to be
 *  worth summarising. */
export function startRecap(opts: RecapOpts): RecapHandle | null {
  if (opts.transcript.length < RECAP_MIN_TRANSCRIPT_ENTRIES) return null;

  let activeQuery: ReturnType<typeof query> | null = null;
  let aborted = false;
  let active = true;

  const done = (async () => {
    try {
      await runRecap(opts, (q) => { activeQuery = q; }, () => aborted);
    } catch (err) {
      console.warn('[memory] recap failed:', err);
    } finally {
      active = false;
      activeQuery = null;
    }
  })();

  return {
    done,
    abort: async () => {
      aborted = true;
      const q = activeQuery;
      if (q) {
        try { await q.interrupt(); } catch { /* ignore */ }
      }
    },
    isActive: () => active,
  };
}

async function runRecap(
  opts: RecapOpts,
  registerQuery: (q: ReturnType<typeof query>) => void,
  isAborted: () => boolean,
): Promise<void> {
  // Stitch the transcript into a single user message, capping the tail so
  // we stay well under Haiku's context window.
  const joined = opts.transcript
    .map((t) => `${t.role === 'user' ? '用户' : '助手'}: ${t.text}`)
    .join('\n');
  const trimmed =
    joined.length > RECAP_TRANSCRIPT_CHAR_CAP
      ? joined.slice(joined.length - RECAP_TRANSCRIPT_CHAR_CAP)
      : joined;

  let responseText = '';
  const env = opts.env ?? mergedSubprocessEnv();
  const q = query({
    prompt: (async function* () {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: trimmed },
        parent_tool_use_id: null,
      };
    })(),
    options: {
      cwd: opts.cwd,
      model: 'claude-haiku-4-5',
      systemPrompt: RECAP_PROMPT,
      tools: [],
      mcpServers: {},
      skills: [],
      settingSources: [],
      permissionMode: 'default',
      includePartialMessages: false,
      env,
    },
  });
  registerQuery(q);
  try {
    for await (const msg of q) {
      if (isAborted()) break;
      const m: any = msg;
      if (m?.type === 'assistant') {
        const text = extractText(m);
        if (text) responseText += `${text}\n`;
      }
    }
  } finally {
    try { q.interrupt().catch(() => { /* ignore */ }); } catch { /* ignore */ }
  }

  if (isAborted()) return;

  // Locate the JSON array in the response. Haiku usually obeys "no markdown"
  // but defensive parsing here is cheap insurance.
  const start = responseText.indexOf('[');
  const end = responseText.lastIndexOf(']');
  if (start < 0 || end <= start) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText.slice(start, end + 1));
  } catch (err) {
    console.warn('[memory] recap JSON parse failed:', err);
    return;
  }
  if (!Array.isArray(parsed)) return;

  let saved = 0;
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const category = r.category;
    const content = r.content;
    const tags = Array.isArray(r.tags)
      ? (r.tags as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    if (
      typeof category !== 'string' ||
      !RECAP_CATEGORIES.has(category as MemoryCategory) ||
      typeof content !== 'string' ||
      content.trim().length === 0
    ) {
      continue;
    }
    const result = await appendEntry({
      category: category as MemoryCategory,
      content,
      tags,
      projectId: opts.projectId,
      sourceMeetingId: opts.meetingId,
    });
    if (result.ok) saved += 1;
  }
  console.log(`[memory] recap saved ${saved} entries from meeting ${opts.meetingId}`);
}

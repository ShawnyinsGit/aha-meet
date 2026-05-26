// memory.ts — long-term cross-meeting memory for vibe-meet.
//
// Mirrors store.ts: a single JSON file under userData/memory.json, written
// atomically (temp+rename) so a crash mid-write can never leave a half-
// truncated file. Reads are fail-soft — corrupt or missing file is treated
// as "empty memory" rather than crashing the app.
//
// Each entry is scoped to a `projectId` (sha1 of realpath(cwd)) so memories
// from one repo don't bleed into another. `selectRelevant` always filters
// by projectId first, then ranks within scope (recency or BM25-ish over
// content+tags) and stops once an approximate token budget is consumed.

import { app } from 'electron';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export type MemoryCategory = 'point' | 'decision' | 'todo' | 'fact';

export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  content: string;
  tags: string[];
  projectId: string;
  sourceMeetingId: string;
  createdAt: number;
  updatedAt: number;
}

interface MemoryFile {
  entries: MemoryEntry[];
}

export interface MemorySelectOpts {
  tokenBudget: number;
  query?: string;
}

export interface MemoryListFilter {
  projectId?: string;
  category?: MemoryCategory;
  query?: string;
}

const MAX_CONTENT_CHARS = 500;
const MAX_TAGS = 10;
const VALID_CATEGORIES: ReadonlySet<MemoryCategory> = new Set([
  'point',
  'decision',
  'todo',
  'fact',
]);

// Secret-shaped strings we refuse to store. Conservative — false positives
// are fine here (the recap pass is best-effort), better to drop a real
// memory than to ever write a token to disk.
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
];

let cachedFile: MemoryFile | null = null;
let cachedPath: string | null = null;

function memoryPath(): string {
  if (cachedPath) return cachedPath;
  cachedPath = join(app.getPath('userData'), 'memory.json');
  return cachedPath;
}

function readFromDisk(): MemoryFile {
  if (cachedFile) return cachedFile;
  const p = memoryPath();
  if (!existsSync(p)) {
    cachedFile = { entries: [] };
    return cachedFile;
  }
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as MemoryFile).entries)
    ) {
      const entries = (parsed as MemoryFile).entries.filter(isValidEntry);
      cachedFile = { entries };
    } else {
      cachedFile = { entries: [] };
    }
  } catch (err) {
    console.error('[memory] failed to parse memory.json, starting fresh:', err);
    cachedFile = { entries: [] };
  }
  return cachedFile;
}

function isValidEntry(e: unknown): e is MemoryEntry {
  if (!e || typeof e !== 'object') return false;
  const x = e as Record<string, unknown>;
  return (
    typeof x.id === 'string' &&
    typeof x.category === 'string' &&
    VALID_CATEGORIES.has(x.category as MemoryCategory) &&
    typeof x.content === 'string' &&
    Array.isArray(x.tags) &&
    typeof x.projectId === 'string' &&
    typeof x.sourceMeetingId === 'string' &&
    typeof x.createdAt === 'number' &&
    typeof x.updatedAt === 'number'
  );
}

function persist(next: MemoryFile): void {
  const p = memoryPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  renameSync(tmp, p);
  cachedFile = next;
}

function containsSecret(text: string): boolean {
  for (const pat of SECRET_PATTERNS) {
    if (pat.test(text)) return true;
  }
  return false;
}

export async function loadMemory(): Promise<MemoryFile> {
  const file = readFromDisk();
  // Return a shallow copy so callers can't mutate the cache directly.
  return { entries: [...file.entries] };
}

export async function appendEntry(
  input: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<{ ok: true; entry: MemoryEntry } | { ok: false; error: string }> {
  if (!VALID_CATEGORIES.has(input.category)) {
    return { ok: false, error: `invalid category: ${input.category}` };
  }
  const content = (input.content ?? '').trim();
  if (content.length === 0) {
    return { ok: false, error: 'content is empty' };
  }
  if (content.length > MAX_CONTENT_CHARS) {
    return { ok: false, error: `content exceeds ${MAX_CONTENT_CHARS} chars` };
  }
  const tags = Array.isArray(input.tags)
    ? input.tags.filter((t) => typeof t === 'string' && t.length > 0).slice(0, MAX_TAGS)
    : [];
  const tagBlob = tags.join(' ');
  if (containsSecret(content) || containsSecret(tagBlob)) {
    return { ok: false, error: 'content matches a secret pattern' };
  }
  if (!input.projectId || !input.sourceMeetingId) {
    return { ok: false, error: 'missing projectId or sourceMeetingId' };
  }
  const now = Date.now();
  const entry: MemoryEntry = {
    id: randomUUID(),
    category: input.category,
    content,
    tags,
    projectId: input.projectId,
    sourceMeetingId: input.sourceMeetingId,
    createdAt: now,
    updatedAt: now,
  };
  const current = readFromDisk();
  persist({ entries: [...current.entries, entry] });
  return { ok: true, entry };
}

export async function updateEntry(
  id: string,
  patch: Partial<Pick<MemoryEntry, 'category' | 'content' | 'tags'>>,
): Promise<MemoryEntry | null> {
  const current = readFromDisk();
  const idx = current.entries.findIndex((e) => e.id === id);
  if (idx < 0) return null;
  const existing = current.entries[idx];
  const nextCategory =
    patch.category && VALID_CATEGORIES.has(patch.category)
      ? patch.category
      : existing.category;
  const nextContent =
    typeof patch.content === 'string' ? patch.content.trim() : existing.content;
  if (nextContent.length === 0 || nextContent.length > MAX_CONTENT_CHARS) {
    return null;
  }
  const nextTags = Array.isArray(patch.tags)
    ? patch.tags.filter((t) => typeof t === 'string' && t.length > 0).slice(0, MAX_TAGS)
    : existing.tags;
  if (containsSecret(nextContent) || containsSecret(nextTags.join(' '))) {
    return null;
  }
  const updated: MemoryEntry = {
    ...existing,
    category: nextCategory,
    content: nextContent,
    tags: nextTags,
    updatedAt: Date.now(),
  };
  const nextEntries = [...current.entries];
  nextEntries[idx] = updated;
  persist({ entries: nextEntries });
  return updated;
}

export async function deleteEntry(id: string): Promise<boolean> {
  const current = readFromDisk();
  const next = current.entries.filter((e) => e.id !== id);
  if (next.length === current.entries.length) return false;
  persist({ entries: next });
  return true;
}

export async function listEntries(
  filter?: MemoryListFilter,
): Promise<MemoryEntry[]> {
  const current = readFromDisk();
  let out = current.entries;
  if (filter?.projectId) {
    out = out.filter((e) => e.projectId === filter.projectId);
  }
  if (filter?.category) {
    out = out.filter((e) => e.category === filter.category);
  }
  if (filter?.query && filter.query.trim().length > 0) {
    const tokens = tokenize(filter.query);
    if (tokens.length > 0) {
      out = out.filter((e) => {
        const blob = `${e.content} ${e.tags.join(' ')}`.toLowerCase();
        return tokens.every((t) => blob.includes(t));
      });
    }
  }
  return [...out].sort((a, b) => b.updatedAt - a.updatedAt);
}

// -----------------------------------------------------------------------------
// Selection / scoring

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9一-鿿]+/)
    .filter((t) => t.length > 0);
}

function approxTokens(text: string): number {
  // Cheap budgetary estimate — Claude tokenizers vary, ~3 chars/token is a
  // safe overestimate for mixed CJK + ASCII content. We only need it to
  // bound how much of memory.json we splice into the system prompt.
  return Math.ceil(text.length / 3);
}

interface ScoredEntry {
  entry: MemoryEntry;
  score: number;
}

// BM25-ish scorer. Real BM25 needs corpus stats and per-term idf; we
// approximate with: per-term tf in the doc, length normalisation against the
// average doc length, plus a small recency boost. This is good enough to
// surface "the user mentioned the name X earlier" without a real index.
function scoreEntries(
  entries: MemoryEntry[],
  queryTokens: string[],
): ScoredEntry[] {
  if (entries.length === 0) return [];
  const docs = entries.map((e) => `${e.content} ${e.tags.join(' ')}`.toLowerCase());
  const docLengths = docs.map((d) => d.length);
  const avgLen =
    docLengths.reduce((a, b) => a + b, 0) / Math.max(1, docLengths.length);
  // idf-ish: how many docs contain each term
  const df = new Map<string, number>();
  for (const term of queryTokens) {
    let count = 0;
    for (const d of docs) if (d.includes(term)) count += 1;
    df.set(term, count);
  }
  const N = entries.length;
  const k1 = 1.2;
  const b = 0.75;
  const now = Date.now();
  const result: ScoredEntry[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    const doc = docs[i];
    const dl = docLengths[i];
    let score = 0;
    for (const term of queryTokens) {
      // tf: simple count of occurrences
      let tf = 0;
      let from = 0;
      while (true) {
        const idx = doc.indexOf(term, from);
        if (idx < 0) break;
        tf += 1;
        from = idx + term.length;
      }
      if (tf === 0) continue;
      const dfi = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - dfi + 0.5) / (dfi + 0.5));
      const norm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / Math.max(1, avgLen))));
      score += idf * norm;
    }
    // Mild recency boost — half-life ~14 days. Keeps ties recent without
    // dominating relevance.
    const ageDays = (now - e.updatedAt) / (1000 * 60 * 60 * 24);
    const recency = Math.exp(-ageDays / 14);
    score = score + 0.2 * recency;
    result.push({ entry: e, score });
  }
  result.sort((a, b) => b.score - a.score);
  return result;
}

export async function selectRelevant(
  projectId: string,
  opts: MemorySelectOpts,
): Promise<MemoryEntry[]> {
  const all = readFromDisk().entries.filter((e) => e.projectId === projectId);
  if (all.length === 0) return [];

  let ranked: MemoryEntry[];
  const queryTokens = opts.query ? tokenize(opts.query) : [];
  if (queryTokens.length > 0) {
    const scored = scoreEntries(all, queryTokens);
    // Drop zero-scoring entries (no term overlap at all) so we don't waste
    // budget on noise.
    ranked = scored.filter((s) => s.score > 0.2).map((s) => s.entry);
    // If everything got filtered out, fall back to recency.
    if (ranked.length === 0) {
      ranked = [...all].sort((a, b) => b.updatedAt - a.updatedAt);
    }
  } else {
    ranked = [...all].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  const out: MemoryEntry[] = [];
  let used = 0;
  for (const e of ranked) {
    const cost = approxTokens(e.content);
    if (used + cost > opts.tokenBudget) break;
    out.push(e);
    used += cost;
  }
  return out;
}

// -----------------------------------------------------------------------------
// Prompt formatting

const CATEGORY_HEADINGS: Record<MemoryCategory, string> = {
  point: '要点',
  decision: '决策',
  todo: '待办',
  fact: '事实',
};

const CATEGORY_ORDER: MemoryCategory[] = ['decision', 'todo', 'point', 'fact'];

export function formatForPrompt(entries: MemoryEntry[]): string {
  if (!entries || entries.length === 0) return '';
  const groups = new Map<MemoryCategory, MemoryEntry[]>();
  for (const e of entries) {
    const list = groups.get(e.category) ?? [];
    list.push(e);
    groups.set(e.category, list);
  }
  const sections: string[] = [];
  for (const cat of CATEGORY_ORDER) {
    const list = groups.get(cat);
    if (!list || list.length === 0) continue;
    const lines: string[] = [`### ${CATEGORY_HEADINGS[cat]}`];
    for (const e of list) {
      const tagSuffix = e.tags.length > 0 ? ` _(${e.tags.join(', ')})_` : '';
      lines.push(`- ${e.content}${tagSuffix}`);
    }
    sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
}

// -----------------------------------------------------------------------------
// Project id

export function computeProjectId(cwd: string): string {
  let canonical = cwd;
  try {
    canonical = realpathSync(cwd);
  } catch {
    // Fall through: realpath can fail on broken symlinks or non-existent
    // paths. Hash the raw cwd in that case so we still get a stable id.
    canonical = cwd;
  }
  return createHash('sha1').update(canonical).digest('hex');
}

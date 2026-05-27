// MemoryPanel — drawer-style settings UI for cross-meeting memory.
//
// Lists everything Claude has chosen to remember about this project, lets the
// user filter by category / query / scope, and supports inline edit and delete.
// All data lives in main.ts → memory.json on disk; this is the only renderer
// surface that touches it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MemoryCategory, MemoryEntry, MemoryListFilter } from '../types';

type CategoryFilter = MemoryCategory | 'all';

const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  point: '要点',
  decision: '决策',
  todo: '待办',
  fact: '事实',
};

const CATEGORY_FILTERS: Array<{ key: CategoryFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'point', label: '要点' },
  { key: 'decision', label: '决策' },
  { key: 'todo', label: '待办' },
  { key: 'fact', label: '事实' },
];

const CATEGORY_COLORS: Record<MemoryCategory, string> = {
  point: '#7cc6ff',
  decision: '#ffd2a8',
  todo: '#ff7a7a',
  fact: '#a4e3a4',
};

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState<T>(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

interface RowProps {
  entry: MemoryEntry;
  onEdit: (id: string, patch: { content: string; category: MemoryCategory; tags: string[] }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

function MemoryRow({ entry, onEdit, onDelete }: RowProps) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [draftContent, setDraftContent] = useState(entry.content);
  const [draftCategory, setDraftCategory] = useState<MemoryCategory>(entry.category);
  const [draftTags, setDraftTags] = useState(entry.tags.join(', '));
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    setDraftContent(entry.content);
    setDraftCategory(entry.category);
    setDraftTags(entry.tags.join(', '));
    setEditing(true);
  };

  const save = async () => {
    if (saving) return;
    const trimmed = draftContent.trim();
    if (trimmed.length === 0 || trimmed.length > 500) return;
    setSaving(true);
    try {
      const tags = draftTags
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .slice(0, 10);
      await onEdit(entry.id, { content: trimmed, category: draftCategory, tags });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="memory-row memory-row-editing">
        <div className="memory-row-edit-controls">
          <select
            className="memory-cat-select"
            value={draftCategory}
            onChange={(e) => setDraftCategory(e.target.value as MemoryCategory)}
          >
            {(Object.keys(CATEGORY_LABELS) as MemoryCategory[]).map((c) => (
              <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
            ))}
          </select>
          <span className="memory-row-charcount">{draftContent.length}/500</span>
        </div>
        <textarea
          className="memory-textarea"
          value={draftContent}
          onChange={(e) => setDraftContent(e.target.value)}
          rows={3}
          maxLength={500}
        />
        <input
          className="memory-tag-input"
          value={draftTags}
          onChange={(e) => setDraftTags(e.target.value)}
          placeholder="tags (comma-separated)"
        />
        <div className="memory-row-actions">
          <button
            type="button"
            className="memory-btn memory-btn-primary"
            onClick={save}
            disabled={saving || draftContent.trim().length === 0}
          >
            保存
          </button>
          <button
            type="button"
            className="memory-btn"
            onClick={() => setEditing(false)}
            disabled={saving}
          >
            取消
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="memory-row">
      <div className="memory-row-head">
        <span
          className="memory-cat-chip"
          style={{ color: CATEGORY_COLORS[entry.category] }}
        >
          {CATEGORY_LABELS[entry.category]}
        </span>
        <span className="memory-row-time">{formatRelative(entry.updatedAt)}</span>
      </div>
      <div className="memory-row-content">{entry.content}</div>
      {entry.tags.length > 0 && (
        <div className="memory-row-tags">
          {entry.tags.map((t) => (
            <span key={t} className="memory-tag-chip">{t}</span>
          ))}
        </div>
      )}
      <div className="memory-row-actions">
        <button type="button" className="memory-btn" onClick={startEdit}>
          编辑
        </button>
        {confirmDelete ? (
          <>
            <button
              type="button"
              className="memory-btn memory-btn-danger"
              onClick={async () => {
                await onDelete(entry.id);
                setConfirmDelete(false);
              }}
            >
              确认删除
            </button>
            <button
              type="button"
              className="memory-btn"
              onClick={() => setConfirmDelete(false)}
            >
              取消
            </button>
          </>
        ) : (
          <button
            type="button"
            className="memory-btn"
            onClick={() => setConfirmDelete(true)}
          >
            删除
          </button>
        )}
      </div>
    </div>
  );
}

export function MemoryPanel() {
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [query, setQuery] = useState('');
  const [scopeProject, setScopeProject] = useState(true);
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const debouncedQuery = useDebounced(query, 200);
  const reloadVersion = useRef(0);

  // Resolve current project id once (it changes only when a session restarts
  // against a different cwd). The "本项目 vs 全部" toggle uses this to scope
  // the listing.
  useEffect(() => {
    let cancelled = false;
    void window.vibeMeet.memory.currentProjectId().then((id) => {
      if (!cancelled) setProjectId(id);
    });
    return () => { cancelled = true; };
  }, []);

  const reload = useCallback(async () => {
    const version = ++reloadVersion.current;
    setLoading(true);
    setError(null);
    try {
      const filter: MemoryListFilter = {};
      if (category !== 'all') filter.category = category;
      if (debouncedQuery.trim().length > 0) filter.query = debouncedQuery.trim();
      if (scopeProject && projectId) filter.projectId = projectId;
      const r = await window.vibeMeet.memory.list(filter);
      if (version !== reloadVersion.current) return;
      if (r.ok) {
        setEntries(r.entries);
      } else {
        setError(r.error);
        setEntries([]);
      }
    } catch (err) {
      if (version === reloadVersion.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (version === reloadVersion.current) setLoading(false);
    }
  }, [category, debouncedQuery, scopeProject, projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleEdit = useCallback(
    async (id: string, patch: { content: string; category: MemoryCategory; tags: string[] }) => {
      const r = await window.vibeMeet.memory.update(id, patch);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      await reload();
    },
    [reload],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      const r = await window.vibeMeet.memory.delete(id);
      if (!r.ok) {
        setError(r.error ?? 'delete failed');
        return;
      }
      await reload();
    },
    [reload],
  );

  const totalLabel = useMemo(() => {
    if (loading) return '加载中…';
    if (entries.length === 0) return '暂无记忆';
    return `${entries.length} 条`;
  }, [loading, entries.length]);

  return (
    <div className="drawer-settings memory-panel">
      <div className="drawer-settings-row">
        <div className="drawer-settings-label">
          <div className="drawer-settings-title">跨会议记忆 · Memory</div>
          <div className="drawer-settings-hint">
            Claude 自动沉淀的要点 / 决策 / 待办 / 事实,会注入下一场会议的开场上下文。
          </div>
        </div>
      </div>

      <div className="memory-controls">
        <div className="memory-chip-row" role="tablist" aria-label="filter by category">
          {CATEGORY_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={category === f.key}
              className={`memory-chip ${category === f.key ? 'memory-chip-active' : ''}`}
              onClick={() => setCategory(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="memory-search-row">
          <input
            className="memory-search-input"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索内容或标签…"
          />
          <button
            type="button"
            className={`memory-scope-toggle ${scopeProject ? 'memory-scope-on' : ''}`}
            onClick={() => setScopeProject((v) => !v)}
            disabled={!projectId}
            title={projectId ? '在本项目 / 全部 之间切换' : '尚未识别项目'}
          >
            {scopeProject && projectId ? '本项目' : '全部'}
          </button>
        </div>
      </div>

      <div className="memory-meta">
        <span>{totalLabel}</span>
        {error && <span className="memory-error">· {error}</span>}
      </div>

      <div className="memory-list">
        {entries.length === 0 && !loading ? (
          <div className="memory-empty">暂无记忆</div>
        ) : (
          entries.map((e) => (
            <MemoryRow
              key={e.id}
              entry={e}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          ))
        )}
      </div>
    </div>
  );
}

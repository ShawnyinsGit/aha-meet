import { useMemo, useState } from 'react';
import type { PlanMeetingTaskInput } from '../types';

interface PlanMeetingModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (tasks: PlanMeetingTaskInput[]) => Promise<{ ok: boolean; error?: string }>;
}

interface ParsedTask {
  title: string;
  deps: string[];
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 32);
  return slug || 'task';
}

function parseInput(raw: string): ParsedTask[] {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const tasks: ParsedTask[] = [];
  for (const line of lines) {
    const parts = line.split(/\s*(?:->|→)\s*/);
    const title = (parts[0] ?? '').trim();
    if (!title) continue;
    const deps = (parts[1] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    tasks.push({ title, deps });
  }
  return tasks;
}

function deriveIds(tasks: ParsedTask[]): string[] {
  const ids: string[] = [];
  for (const t of tasks) {
    const base = slugify(t.title);
    let id = base;
    let n = 2;
    while (ids.includes(id)) {
      id = `${base}-${n++}`;
    }
    ids.push(id);
  }
  return ids;
}

const PLACEHOLDER = `Refactor auth module
Write auth tests -> refactor-auth-module
Security scan -> refactor-auth-module`;

export function PlanMeetingModal({ open, onClose, onSubmit }: PlanMeetingModalProps) {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => parseInput(text), [text]);
  const ids = useMemo(() => deriveIds(parsed), [parsed]);

  if (!open) return null;

  const handleSubmit = async () => {
    setError(null);
    if (parsed.length === 0) {
      setError('Enter at least one task.');
      return;
    }
    const payload: PlanMeetingTaskInput[] = parsed.map((t, i) => ({
      id: ids[i],
      title: t.title,
      prompt: t.title,
      deps: t.deps,
    }));
    setSubmitting(true);
    const res = await onSubmit(payload);
    setSubmitting(false);
    if (res.ok) {
      setText('');
      onClose();
    } else {
      setError(res.error ?? 'Failed to install plan.');
    }
  };

  return (
    <div className="plan-modal-backdrop" onClick={onClose}>
      <div className="plan-modal" onClick={(e) => e.stopPropagation()}>
        <header className="plan-modal-header">
          <h2>Plan meeting</h2>
          <button type="button" className="plan-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <p className="plan-modal-help">
          One task per line. Use <code>-&gt;</code> or <code>→</code> after the title to declare
          dependencies on the IDs shown in the preview.
        </p>
        <textarea
          className="plan-modal-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={PLACEHOLDER}
          rows={8}
          spellCheck={false}
        />
        {parsed.length > 0 && (
          <div className="plan-modal-preview">
            <div className="plan-modal-preview-label">Preview</div>
            <ul>
              {parsed.map((t, i) => (
                <li key={ids[i]}>
                  <code>{ids[i]}</code> — {t.title}
                  {t.deps.length > 0 && (
                    <span className="plan-modal-deps"> ← {t.deps.join(', ')}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && <div className="plan-modal-error">{error}</div>}
        <div className="plan-modal-actions">
          <button type="button" className="plan-modal-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="plan-modal-submit"
            disabled={submitting || parsed.length === 0}
            onClick={handleSubmit}
          >
            {submitting
              ? 'Planning…'
              : `Plan ${parsed.length} task${parsed.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

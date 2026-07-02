import { useMemo } from 'react';
import { FileEdit, FilePlus, FileText } from 'lucide-react';
import type { ActivityEntry } from '../types';

interface ReviewPanelProps {
  activity: ActivityEntry[];
}

interface FileChange {
  id: string;
  tool: 'Write' | 'Edit';
  path: string;
  detail: string;
  ts: number;
}

export function ReviewPanel({ activity }: ReviewPanelProps) {
  const changes = useMemo(() => {
    const result: FileChange[] = [];

    for (const entry of activity) {
      if (entry.kind !== 'tool-call') continue;
      if (entry.title !== 'Tool: Write' && entry.title !== 'Tool: Edit') continue;

      const input = tryParseJson(entry.detail || '');
      const rawPath = input?.file_path || input?.path || 'unknown';
      const path = typeof rawPath === 'string' ? rawPath : 'unknown';
      const tool = entry.title === 'Tool: Write' ? 'Write' : 'Edit';

      const detail = buildChangeDetail(input, tool);

      result.push({
        id: entry.id,
        tool,
        path,
        detail,
        ts: entry.ts,
      });
    }

    return result;
  }, [activity]);

  if (changes.length === 0) {
    return (
      <div className="review-panel-empty">
        <FileText size={32} />
        <p>No file changes yet</p>
      </div>
    );
  }

  return (
    <div className="review-panel">
      <div className="review-panel-summary">
        {changes.length} file change{changes.length !== 1 ? 's' : ''}
      </div>
      {changes.map((change) => (
        <div key={change.id} className="review-change">
          <div className="review-change-header">
            {change.tool === 'Write' ? <FilePlus size={14} /> : <FileEdit size={14} />}
            <span className="review-change-tool">{change.tool}</span>
            <span className="review-change-path">{change.path}</span>
            <span className="review-change-ts">{new Date(change.ts).toLocaleTimeString()}</span>
          </div>
          {change.detail && (
            <pre className="review-change-detail">{change.detail}</pre>
          )}
        </div>
      ))}
    </div>
  );
}

function tryParseJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function buildChangeDetail(input: Record<string, unknown> | null, tool: 'Write' | 'Edit'): string {
  if (!input) return '';
  if (tool === 'Write') {
    const content = typeof input.content === 'string' ? input.content : '';
    if (content.length > 400) return content.slice(0, 400) + '...';
    return content;
  }
  const oldStr = typeof input.old_string === 'string' ? input.old_string : '';
  const newStr = typeof input.new_string === 'string' ? input.new_string : '';
  const lines: string[] = [];
  if (oldStr) lines.push(`- ${oldStr.slice(0, 200)}`);
  if (newStr) lines.push(`+ ${newStr.slice(0, 200)}`);
  return lines.join('\n');
}

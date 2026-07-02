import { useMemo } from 'react';
import { Terminal as TerminalIcon, ChevronRight } from 'lucide-react';
import type { ActivityEntry } from '../types';

interface TerminalPanelProps {
  activity: ActivityEntry[];
}

interface TerminalBlock {
  id: string;
  command: string;
  output?: string;
  isError: boolean;
  ts: number;
}

export function TerminalPanel({ activity }: TerminalPanelProps) {
  const blocks = useMemo(() => {
    const result: TerminalBlock[] = [];
    const calls = activity.filter((a) => a.kind === 'tool-call' && a.title === 'Tool: Bash');

    for (const call of calls) {
      const input = call.detail ? tryParseJson(call.detail) : null;
      const command = input?.command || call.detail || '';

      const nextIdx = activity.findIndex(
        (a) => a.ts > call.ts && a.kind === 'tool-result',
      );
      const output = nextIdx >= 0 ? activity[nextIdx].detail : undefined;
      const isError = nextIdx >= 0 && activity[nextIdx].title.includes('error');

      result.push({
        id: call.id,
        command,
        output,
        isError,
        ts: call.ts,
      });
    }

    return result;
  }, [activity]);

  if (blocks.length === 0) {
    return (
      <div className="terminal-panel-empty">
        <TerminalIcon size={32} />
        <p>No terminal commands yet</p>
      </div>
    );
  }

  return (
    <div className="terminal-panel">
      {blocks.map((block) => (
        <div key={block.id} className={`terminal-block ${block.isError ? 'terminal-block-error' : ''}`}>
          <div className="terminal-block-header">
            <ChevronRight size={12} />
            <span className="terminal-block-ts">{new Date(block.ts).toLocaleTimeString()}</span>
          </div>
          <pre className="terminal-block-command">{block.command}</pre>
          {block.output && (
            <pre className="terminal-block-output">{block.output}</pre>
          )}
        </div>
      ))}
    </div>
  );
}

function tryParseJson(s: string): { command?: string } | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

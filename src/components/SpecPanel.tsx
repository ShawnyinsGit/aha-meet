import { useMemo } from 'react';
import { FileText } from 'lucide-react';
import type { TranscriptEntry } from '../types';

interface SpecPanelProps {
  transcript: TranscriptEntry[];
  workerTitle: string;
}

export function SpecPanel({ transcript, workerTitle }: SpecPanelProps) {
  const messages = useMemo(() => {
    return transcript.filter((e) => e.role === 'assistant' && e.text.trim().length > 0);
  }, [transcript]);

  if (messages.length === 0) {
    return (
      <div className="spec-panel-empty">
        <FileText size={32} />
        <p>No assistant messages yet</p>
      </div>
    );
  }

  return (
    <div className="spec-panel">
      <div className="spec-panel-header">
        <h3>{workerTitle}</h3>
        <span className="spec-panel-count">{messages.length} message{messages.length !== 1 ? 's' : ''}</span>
      </div>
      {messages.map((msg) => (
        <div key={msg.id} className="spec-message">
          <div className="spec-message-meta">
            <span className="spec-message-role">Assistant</span>
            <span className="spec-message-ts">{new Date(msg.ts).toLocaleTimeString()}</span>
          </div>
          <div className="spec-message-text">{msg.text}</div>
        </div>
      ))}
    </div>
  );
}

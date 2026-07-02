import { useState } from 'react';
import { Monitor, Terminal as TerminalIcon, FileSearch, FileText, Database } from 'lucide-react';
import { ClaudeWorkspace } from './ClaudeWorkspace';
import { TerminalPanel } from './TerminalPanel';
import { ReviewPanel } from './ReviewPanel';
import { SpecPanel } from './SpecPanel';
import type { WorkerState } from '../lib/meeting-store';
import type { DeliverySnapshot } from '../lib/meeting-store';

type TabType = 'activity' | 'browser' | 'terminal' | 'review' | 'spec' | 'supabase';

interface Tab {
  id: TabType;
  label: string;
  icon: React.ReactNode;
}

const TABS: Tab[] = [
  { id: 'activity', label: 'Activity', icon: <FileSearch size={14} /> },
  { id: 'browser', label: 'Browser', icon: <Monitor size={14} /> },
  { id: 'terminal', label: 'Terminal', icon: <TerminalIcon size={14} /> },
  { id: 'review', label: 'Review', icon: <FileText size={14} /> },
  { id: 'spec', label: 'Spec', icon: <FileText size={14} /> },
  { id: 'supabase', label: 'Supabase', icon: <Database size={14} /> },
];

interface ParticipantContentTabsProps {
  worker: WorkerState;
  running: boolean;
  aiSpeaking: boolean;
  deliveryHistory?: DeliverySnapshot[];
  onAcceptDelivery?: () => void;
}

export function ParticipantContentTabs({
  worker,
  running,
  aiSpeaking,
  deliveryHistory,
  onAcceptDelivery,
}: ParticipantContentTabsProps) {
  const [activeTab, setActiveTab] = useState<TabType>('activity');

  return (
    <div className="participant-tabs">
      <div className="participant-tabs-bar">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`participant-tab ${activeTab === tab.id ? 'participant-tab-active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
            type="button"
          >
            <span className="participant-tab-icon">{tab.icon}</span>
            <span className="participant-tab-label">{tab.label}</span>
          </button>
        ))}
      </div>
      <div className="participant-tabs-content">
        {activeTab === 'activity' && (
          <ClaudeWorkspace
            speaking={worker.role === 'talker' && aiSpeaking}
            awaitingPermission={Boolean(worker.pendingPermission)}
            running={running}
            transcript={worker.transcript}
            activity={worker.activity}
            name={worker.title}
            subtitle={worker.role === 'talker' ? 'Host · Talker' : 'Worker'}
            avatar={worker.role === 'talker' ? 'claude' : 'worker'}
            initial={worker.title.trim().slice(0, 1).toUpperCase()}
            hideHero
            task={
              worker.role === 'talker'
                ? (worker.lastText || 'Ready')
                : worker.title
            }
            taskStatus={
              worker.role === 'talker'
                ? (aiSpeaking ? 'speaking' : running ? 'running' : 'idle')
                : (worker.role === 'worker' && aiSpeaking ? 'speaking' : worker.status)
            }
            taskSpecialty={worker.role === 'talker' ? undefined : worker.specialty}
            taskDeps={worker.role === 'talker' ? undefined : worker.deps}
            taskHistory={worker.role === 'talker' ? undefined : worker.taskHistory}
            currentTool={worker.currentTool}
            currentToolInput={worker.currentToolInput}
            lastText={worker.lastText}
            startedAt={worker.startedAt}
            pendingPermissionTool={worker.pendingPermission?.toolName ?? null}
            deliveryHistory={worker.role === 'talker' ? deliveryHistory : undefined}
            onAcceptDelivery={worker.role === 'talker' ? onAcceptDelivery : undefined}
          />
        )}
        {activeTab === 'browser' && (
          <div className="participant-placeholder">
            <Monitor size={48} />
            <p>Browser integration coming soon</p>
            <p className="participant-placeholder-hint">View and interact with web content</p>
          </div>
        )}
        {activeTab === 'terminal' && (
          <TerminalPanel activity={worker.activity} />
        )}
        {activeTab === 'review' && (
          <ReviewPanel activity={worker.activity} />
        )}
        {activeTab === 'spec' && (
          <SpecPanel transcript={worker.transcript} workerTitle={worker.title} />
        )}
        {activeTab === 'supabase' && (
          <div className="participant-placeholder">
            <Database size={48} />
            <p>Supabase coming soon</p>
            <p className="participant-placeholder-hint">Query and manage your database</p>
          </div>
        )}
      </div>
    </div>
  );
}

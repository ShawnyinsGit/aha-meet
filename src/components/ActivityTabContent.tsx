import { useState, useEffect, useMemo, useCallback } from 'react';
import type { WorkerState } from '../lib/meeting-store';
import type { MeetingPlan } from '../types';
import { ClaudeWorkspace } from './ClaudeWorkspace';
import { UserTasksPanel } from './UserTasksPanel';

const USER_SLOT = 'user';

interface ActivityTabContentProps {
  workers: WorkerState[];
  plan: MeetingPlan | null;
  running: boolean;
  aiSpeaking: boolean;
  onResolvePermission: (id: string, decision: 'allow' | 'deny') => void;
  onSelectUser: () => void;
  selectedUser: boolean;
}

export function ActivityTabContent({
  workers,
  plan,
  running,
  aiSpeaking,
  onResolvePermission,
  onSelectUser,
  selectedUser,
}: ActivityTabContentProps) {
  const sortedWorkers = useMemo(() => {
    const statusPriority = (w: WorkerState): number => {
      if (w.role === 'talker') return 0;
      switch (w.status) {
        case 'running': return 1;
        case 'pending': return 2;
        case 'idle':    return 3;
        case 'done':    return 4;
        case 'failed':  return 4;
        default:        return 3;
      }
    };
    return [...workers].sort((a, b) => {
      const pa = statusPriority(a);
      const pb = statusPriority(b);
      if (pa !== pb) return pa - pb;
      const aTs = a.activity.length > 0 ? a.activity[0].ts : 0;
      const bTs = b.activity.length > 0 ? b.activity[0].ts : 0;
      if (aTs !== bTs) return aTs - bTs;
      return a.id.localeCompare(b.id);
    });
  }, [workers]);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (selectedUser) {
      setSelectedId(USER_SLOT);
    }
  }, [selectedUser]);

  useEffect(() => {
    if (selectedId && selectedId !== USER_SLOT && !workers.some((w) => w.id === selectedId)) {
      setSelectedId(null);
    }
  }, [selectedId, workers]);

  const effectiveSelected = selectedId ?? 'talker';
  const selectedWorker =
    effectiveSelected === USER_SLOT
      ? null
      : (sortedWorkers.find((w) => w.id === effectiveSelected) ?? sortedWorkers[0] ?? null);

  const handleSelectWorker = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  return (
    <div className="activity-detail">
      {effectiveSelected === USER_SLOT ? (
        <UserTasksPanel workers={workers} />
      ) : selectedWorker && (
        <ClaudeWorkspace
          key={selectedWorker.id}
          speaking={selectedWorker.role === 'talker' && aiSpeaking}
          awaitingPermission={Boolean(selectedWorker.pendingPermission)}
          running={running}
          transcript={selectedWorker.transcript}
          activity={selectedWorker.activity}
          name={selectedWorker.title}
          subtitle={selectedWorker.role === 'talker' ? 'Host · Talker' : 'Worker'}
          avatar={selectedWorker.role === 'talker' ? 'claude' : 'worker'}
          initial={selectedWorker.title.trim().slice(0, 1).toUpperCase()}
          hideHero
          task={
            selectedWorker.role === 'talker'
              ? (selectedWorker.lastText || 'Ready')
              : selectedWorker.title
          }
          taskStatus={
            selectedWorker.role === 'talker'
              ? (aiSpeaking ? 'speaking' : running ? 'running' : 'idle')
              : (selectedWorker.role === 'worker' && aiSpeaking ? 'speaking' : selectedWorker.status)
          }
          taskSpecialty={selectedWorker.role === 'talker' ? undefined : selectedWorker.specialty}
          taskDeps={selectedWorker.role === 'talker' ? undefined : selectedWorker.deps}
          taskHistory={selectedWorker.role === 'talker' ? undefined : selectedWorker.taskHistory}
          currentTool={selectedWorker.currentTool}
          currentToolInput={selectedWorker.currentToolInput}
          lastText={selectedWorker.lastText}
          startedAt={selectedWorker.startedAt}
          pendingPermissionTool={selectedWorker.pendingPermission?.toolName ?? null}
        />
      )}
    </div>
  );
}

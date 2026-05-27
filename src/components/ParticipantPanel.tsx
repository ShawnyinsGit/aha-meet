import { cloneElement, isValidElement, useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import type { WorkerState } from '../lib/meeting-store';
import type { MeetingPlan } from '../types';
import { ClaudeWorkspace } from './ClaudeWorkspace';
import { WorkerCard } from './WorkerCard';
import { UserTasksPanel } from './UserTasksPanel';

const USER_SLOT = 'user';

interface ParticipantPanelProps {
  workers: WorkerState[];
  plan: MeetingPlan | null;
  running: boolean;
  aiSpeaking: boolean;
  selfTile: ReactNode;
  onResolvePermission: (id: string, decision: 'allow' | 'deny') => void;
}

export function ParticipantPanel({
  workers,
  plan,
  running,
  aiSpeaking,
  selfTile,
  onResolvePermission,
}: ParticipantPanelProps) {
  const sortedWorkers = useMemo(() => {
    // Priority order:
    // 0 = talker (host, always first)
    // 1 = running workers (active, most relevant)
    // 2 = pending workers (queued, about to run)
    // 3 = idle workers
    // 4 = done / failed (finished, pushed to end)
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
      // Within the same priority bucket, sort by first-activity timestamp (earliest first)
      const aTs = a.activity.length > 0 ? a.activity[0].ts : 0;
      const bTs = b.activity.length > 0 ? b.activity[0].ts : 0;
      if (aTs !== bTs) return aTs - bTs;
      return a.id.localeCompare(b.id);
    });
  }, [workers]);

  const depTitles = useMemo(() => {
    const map = new Map<string, string>();
    if (plan) for (const n of plan.nodes) map.set(n.id, n.title);
    for (const w of workers) map.set(w.id, w.title);
    return map;
  }, [plan, workers]);

  // Default: host (talker) workspace expanded. Selection only changes when the
  // user explicitly clicks a tile. The synthetic USER_SLOT id corresponds to
  // clicking your own avatar — renders the user-task list in the detail area.
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  const handleSelectUser = useCallback(() => setSelectedId(USER_SLOT), []);

  // Inject selection + click handler into the caller-provided self tile so it
  // behaves the same as any worker tile. The caller can still pass its own
  // onClick — we wrap it.
  const wrappedSelfTile = useMemo(() => {
    if (!isValidElement(selfTile)) return selfTile;
    const el = selfTile as ReactElement<Record<string, unknown>>;
    const props = el.props ?? {};
    const existingClick = props.onClick as (() => void) | undefined;
    return cloneElement(el, {
      selected: effectiveSelected === USER_SLOT,
      onClick: () => {
        existingClick?.();
        handleSelectUser();
      },
    });
  }, [selfTile, effectiveSelected, handleSelectUser]);

  const [barCollapsed, setBarCollapsed] = useState(false);

  return (
    <aside className="tiles tiles--stack">
      <div className={`tiles-bar ${barCollapsed ? 'tiles-bar-collapsed' : ''}`}>
        <div className="tiles-bar-scroll">
          <div className="tiles-bar-self">{wrappedSelfTile}</div>
          {sortedWorkers.map((w) => (
            <WorkerCard
              key={w.id}
              worker={w}
              depTitles={depTitles}
              mode="gallery"
              selected={w.id === effectiveSelected}
              speaking={w.role === 'talker' && aiSpeaking}
              onSelect={() => setSelectedId(w.id)}
              onResolvePermission={onResolvePermission}
            />
          ))}
        </div>
        <button
          type="button"
          className="tiles-bar-collapse"
          onClick={() => setBarCollapsed((v) => !v)}
          aria-label={barCollapsed ? '展开参会人' : '收起参会人'}
          title={barCollapsed ? '展开参会人' : '收起参会人'}
        >
          {barCollapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </button>
      </div>
      <div className="tiles-detail">
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
                ? undefined
                : (selectedWorker.status === 'running' || selectedWorker.status === 'pending') && selectedWorker.title
                  ? selectedWorker.title
                  : null
            }
            taskStatus={
              selectedWorker.role === 'talker'
                ? undefined
                : (selectedWorker.role === 'worker' && aiSpeaking
                    ? 'speaking'
                    : selectedWorker.status)
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
    </aside>
  );
}

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import type { WorkerState } from '../lib/meeting-store';
import type { MeetingPlan } from '../types';
import { ClaudeWorkspace } from './ClaudeWorkspace';
import { WorkerCard } from './WorkerCard';

interface ParticipantPanelProps {
  workers: WorkerState[];
  plan: MeetingPlan | null;
  cwd: string | null;
  running: boolean;
  aiSpeaking: boolean;
  selfTile: ReactNode;
  onResolvePermission: (id: string, decision: 'allow' | 'deny') => void;
}

export function ParticipantPanel({
  workers,
  plan,
  cwd,
  running,
  aiSpeaking,
  selfTile,
  onResolvePermission,
}: ParticipantPanelProps) {
  const sortedWorkers = useMemo(() => {
    return [...workers].sort((a, b) => {
      if (a.role === 'talker') return -1;
      if (b.role === 'talker') return 1;
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
  // user explicitly clicks a tile.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (selectedId && !workers.some((w) => w.id === selectedId)) {
      setSelectedId(null);
    }
  }, [selectedId, workers]);

  const effectiveSelected = selectedId ?? 'talker';
  const selectedWorker =
    sortedWorkers.find((w) => w.id === effectiveSelected) ?? sortedWorkers[0] ?? null;

  const [barCollapsed, setBarCollapsed] = useState(false);

  return (
    <aside className="tiles tiles--stack">
      <div className={`tiles-bar ${barCollapsed ? 'tiles-bar-collapsed' : ''}`}>
        <div className="tiles-bar-scroll">
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
          <div className="tiles-bar-self">{selfTile}</div>
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
        {selectedWorker && (
          <ClaudeWorkspace
            key={selectedWorker.id}
            cwd={cwd}
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
          />
        )}
      </div>
    </aside>
  );
}

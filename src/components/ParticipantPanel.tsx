import { useMemo } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import type { WorkerState } from '../lib/meeting-store';
import type { MeetingPlan } from '../types';
import { WorkerCard } from './WorkerCard';

interface ParticipantPanelProps {
  workers: WorkerState[];
  plan: MeetingPlan | null;
  running: boolean;
  aiSpeaking: boolean;
  selfTile: React.ReactNode;
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

  const depTitles = useMemo(() => {
    const map = new Map<string, string>();
    if (plan) for (const n of plan.nodes) map.set(n.id, n.title);
    for (const w of workers) map.set(w.id, w.title);
    return map;
  }, [plan, workers]);

  const [barCollapsed, setBarCollapsed] = useState(false);

  return (
    <div className={`tiles-bar ${barCollapsed ? 'tiles-bar-collapsed' : ''}`}>
      <div className="tiles-bar-scroll">
        <div className="tiles-bar-self">{selfTile}</div>
        {sortedWorkers.map((w) => (
          <WorkerCard
            key={w.id}
            worker={w}
            depTitles={depTitles}
            mode="gallery"
            selected={false}
            speaking={w.role === 'talker' && aiSpeaking}
            onSelect={() => {}}
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
  );
}

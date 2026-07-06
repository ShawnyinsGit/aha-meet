import { memo, useMemo } from 'react';
import { ChevronUp, ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { useState, useCallback } from 'react';
import type { HostGroupState, WorkerState } from '../lib/meeting-store';
import type { MeetingPlan } from '../types';
import { WorkerCard } from './WorkerCard';

interface ParticipantPanelProps {
  workers: WorkerState[];
  hostGroups: Map<string, HostGroupState>;
  plan: MeetingPlan | null;
  running: boolean;
  aiSpeaking: boolean;
  selfTile: React.ReactNode;
  onResolvePermission: (id: string, decision: 'allow' | 'deny') => void;
  onToggleHostGroup: (hostId: string) => void;
  onAddHost?: (backendId: string) => void;
}

const BACKEND_LABELS: Record<string, string> = {
  'claude-code': 'Claude',
  'codex': 'Codex',
  'kimi': 'Kimi',
  'qoder': 'Qoder',
};

const BACKEND_OPTIONS = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex CLI' },
  { id: 'kimi', label: 'Kimi CLI' },
  { id: 'qoder', label: 'Qoder CLI' },
];

export const ParticipantPanel = memo(function ParticipantPanel({
  workers,
  hostGroups,
  plan,
  running,
  aiSpeaking,
  selfTile,
  onResolvePermission,
  onToggleHostGroup,
  onAddHost,
}: ParticipantPanelProps) {
  const [barCollapsed, setBarCollapsed] = useState(false);
  const [showAddMenu, setShowAddMenu] = useState(false);

  const depTitles = useMemo(() => {
    const map = new Map<string, string>();
    if (plan) for (const n of plan.nodes) map.set(n.id, n.title);
    for (const w of workers) map.set(w.id, w.title);
    return map;
  }, [plan, workers]);

  // Group workers by hostId.
  const groupedWorkers = useMemo(() => {
    const groups = new Map<string, WorkerState[]>();
    for (const w of workers) {
      const hid = w.hostId || 'default';
      let list = groups.get(hid);
      if (!list) {
        list = [];
        groups.set(hid, list);
      }
      list.push(w);
    }
    return groups;
  }, [workers]);

  const sortWorkers = useCallback((list: WorkerState[]): WorkerState[] => {
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
    return [...list].sort((a, b) => {
      const pa = statusPriority(a);
      const pb = statusPriority(b);
      if (pa !== pb) return pa - pb;
      const aTs = a.activity.length > 0 ? a.activity[0].ts : 0;
      const bTs = b.activity.length > 0 ? b.activity[0].ts : 0;
      if (aTs !== bTs) return aTs - bTs;
      return a.id.localeCompare(b.id);
    });
  }, []);

  // Sort host groups: 'default' first, then by id.
  const sortedHostGroups = useMemo(() => {
    const entries = Array.from(hostGroups.entries());
    entries.sort(([a], [b]) => {
      if (a === 'default') return -1;
      if (b === 'default') return 1;
      return a.localeCompare(b);
    });
    return entries;
  }, [hostGroups]);

  const handleAddHost = useCallback((backendId: string) => {
    setShowAddMenu(false);
    onAddHost?.(backendId);
  }, [onAddHost]);

  return (
    <div className={`tiles-bar ${barCollapsed ? 'tiles-bar-collapsed' : ''}`}>
      <div className="tiles-bar-scroll">
        <div className="tiles-bar-self">{selfTile}</div>
        {sortedHostGroups.map(([hostId, hg]) => {
          const hostWorkers = groupedWorkers.get(hostId) ?? [];
          const sorted = sortWorkers(hostWorkers);
          const talker = sorted.find((w) => w.role === 'talker');
          const workerList = sorted.filter((w) => w.role !== 'talker');
          const isDefault = hostId === 'default';
          const backendLabel = BACKEND_LABELS[hg.backendId] ?? hg.backendId;

          return (
            <div key={hostId} className="host-group-tile">
              {/* Host group header */}
              {!isDefault && (
                <button
                  type="button"
                  className="host-group-header"
                  onClick={() => onToggleHostGroup(hostId)}
                >
                  <span className="host-group-badge">{backendLabel}</span>
                  <span className="host-group-count">{workerList.length} worker{workerList.length !== 1 ? 's' : ''}</span>
                  {hg.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </button>
              )}

              {/* Talker card always visible */}
              {talker && (
                <WorkerCard
                  worker={talker}
                  depTitles={depTitles}
                  mode="gallery"
                  selected={false}
                  speaking={aiSpeaking}
                  onSelect={() => {}}
                  onResolvePermission={onResolvePermission}
                />
              )}

              {/* Worker cards — collapsible for non-default hosts */}
              {(isDefault || !hg.collapsed) && workerList.map((w) => (
                <WorkerCard
                  key={w.id}
                  worker={w}
                  depTitles={depTitles}
                  mode="gallery"
                  selected={false}
                  speaking={false}
                  onSelect={() => {}}
                  onResolvePermission={onResolvePermission}
                />
              ))}
            </div>
          );
        })}
      </div>

      {/* Add host button */}
      {onAddHost && (
        <div className="host-group-add-wrap">
          {showAddMenu && (
            <div className="host-group-add-menu">
              <div className="host-group-add-menu-title">添加主持</div>
              {BACKEND_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className="host-group-add-item"
                  onClick={() => handleAddHost(opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className="host-group-add-btn"
            onClick={() => setShowAddMenu((v) => !v)}
            title="添加新的主持 (Host)"
          >
            <Plus size={14} />
            <span>Host</span>
          </button>
        </div>
      )}

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
});

import { memo, useMemo } from 'react';
import { ChevronDown, ChevronUp, UserPlus } from 'lucide-react';
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
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [showInviteMenu, setShowInviteMenu] = useState(false);

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

  const handleHostClick = useCallback((hostId: string) => {
    setSelectedHostId((prev) => (prev === hostId ? null : hostId));
  }, []);

  const handleAddHost = useCallback((backendId: string) => {
    setShowInviteMenu(false);
    onAddHost?.(backendId);
  }, [onAddHost]);

  // Get talker for each host (for the host strip)
  const hostTalkers = useMemo(() => {
    const map = new Map<string, WorkerState>();
    for (const [hostId, hostWorkers] of groupedWorkers.entries()) {
      const talker = hostWorkers.find((w) => w.role === 'talker');
      if (talker) map.set(hostId, talker);
    }
    return map;
  }, [groupedWorkers]);

  // Get worker count for each host
  const hostWorkerCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const [hostId, hostWorkers] of groupedWorkers.entries()) {
      const count = hostWorkers.filter((w) => w.role !== 'talker').length;
      map.set(hostId, count);
    }
    return map;
  }, [groupedWorkers]);

  // Workers for the selected host
  const selectedHostWorkers = useMemo(() => {
    if (!selectedHostId) return [];
    const hostWorkers = groupedWorkers.get(selectedHostId) ?? [];
    return sortWorkers(hostWorkers.filter((w) => w.role !== 'talker'));
  }, [selectedHostId, groupedWorkers, sortWorkers]);

  return (
    <div className="participant-container">
      {/* Host strip */}
      <div className="host-strip">
        <div className="host-strip-scroll">
          {/* Self tile (You) */}
          <div className="host-tile self-tile">{selfTile}</div>

          {/* Host cards */}
          {sortedHostGroups.map(([hostId, hg]) => {
            const talker = hostTalkers.get(hostId);
            const workerCount = hostWorkerCounts.get(hostId) ?? 0;
            const isSelected = selectedHostId === hostId;
            const backendLabel = BACKEND_LABELS[hg.backendId] ?? hg.backendId;

            return (
              <div
                key={hostId}
                className={`host-card ${isSelected ? 'host-card-selected' : ''}`}
                onClick={() => handleHostClick(hostId)}
              >
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
                <div className="host-card-footer">
                  <span className="host-card-backend">{backendLabel}</span>
                  {workerCount > 0 && (
                    <span className="host-card-worker-count">
                      {workerCount} worker{workerCount !== 1 ? 's' : ''}
                    </span>
                  )}
                  {workerCount > 0 && (
                    <ChevronDown
                      size={14}
                      className={`host-card-chevron ${isSelected ? 'rotated' : ''}`}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Invite dropdown */}
        {onAddHost && (
          <div className="invite-dropdown-wrap">
            {showInviteMenu && (
              <div className="invite-menu">
                <div className="invite-menu-title">邀请参会人</div>
                {BACKEND_OPTIONS.map((opt) => {
                  const alreadyAdded = sortedHostGroups.some(
                    ([, hg]) => hg.backendId === opt.id
                  );
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      className={`invite-menu-item ${alreadyAdded ? 'disabled' : ''}`}
                      onClick={() => !alreadyAdded && handleAddHost(opt.id)}
                      disabled={alreadyAdded}
                    >
                      {opt.label}
                      {alreadyAdded && <span className="invite-added-badge">已添加</span>}
                    </button>
                  );
                })}
              </div>
            )}
            <button
              type="button"
              className="invite-btn"
              onClick={() => setShowInviteMenu((v) => !v)}
              title="邀请新的参会人"
            >
              <UserPlus size={14} />
              <span>邀请</span>
            </button>
          </div>
        )}
      </div>

      {/* Worker panel (below host strip when a host is selected) */}
      {selectedHostId && selectedHostWorkers.length > 0 && (
        <div className="worker-panel">
          <div className="worker-panel-header">
            <span className="worker-panel-title">
              {BACKEND_LABELS[hostGroups.get(selectedHostId)?.backendId ?? ''] ?? 'Workers'}
            </span>
            <button
              type="button"
              className="worker-panel-close"
              onClick={() => setSelectedHostId(null)}
              title="收起 workers"
            >
              <ChevronUp size={14} />
            </button>
          </div>
          <div className="worker-panel-scroll">
            {selectedHostWorkers.map((w) => (
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
        </div>
      )}
    </div>
  );
});

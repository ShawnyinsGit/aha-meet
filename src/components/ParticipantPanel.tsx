import { memo, useMemo, useState, useCallback } from 'react';
import { ChevronDown, ChevronUp, UserPlus } from 'lucide-react';
import type { HostGroupState, WorkerState } from '../lib/meeting-store';
import { WorkerCard } from './WorkerCard';

interface ParticipantPanelProps {
  workers: WorkerState[];
  hostGroups: Map<string, HostGroupState>;
  running: boolean;
  aiSpeaking: boolean;
  selfTile: React.ReactNode;
  onAddHost?: (backendId: string) => void;
}

const BACKEND_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  'codex': 'Codex CLI',
  'kimi': 'Kimi CLI',
  'qoder': 'Qoder CLI',
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
  running,
  aiSpeaking,
  selfTile,
  onAddHost,
}: ParticipantPanelProps) {
  const [showInviteMenu, setShowInviteMenu] = useState(false);
  const [barCollapsed, setBarCollapsed] = useState(false);

  // Find the talker worker for each host group
  const hostTalkers = useMemo(() => {
    const map = new Map<string, WorkerState>();
    for (const w of workers) {
      if (w.role === 'talker') map.set(w.hostId || 'default', w);
    }
    return map;
  }, [workers]);

  // Sort host groups: 'default' first, then alphabetically
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
    setShowInviteMenu(false);
    onAddHost?.(backendId);
  }, [onAddHost]);

  return (
    <aside className="tiles tiles--stack">
      <div className={`tiles-bar ${barCollapsed ? 'tiles-bar-collapsed' : ''}`}>
        <div className="tiles-bar-scroll">
          {/* Self tile */}
          <div className="tiles-bar-self">{selfTile}</div>

          {/* Host talker tiles */}
          {sortedHostGroups.map(([hostId, hg]) => {
            const talker = hostTalkers.get(hostId);
            if (!talker) return null;

            return (
              <WorkerCard
                key={hostId}
                worker={talker}
                depTitles={new Map()}
                mode="gallery"
                selected={false}
                speaking={aiSpeaking && talker.role === 'talker'}
                onSelect={() => {}}
                onResolvePermission={() => {}}
              />
            );
          })}

          {/* Invite button */}
          {onAddHost && (
            <div className="tiles-bar-invite-wrap">
              {showInviteMenu && (
                <div className="tiles-bar-invite-dropdown">
                  <div className="tiles-bar-invite-title">邀请参会人</div>
                  {BACKEND_OPTIONS.map((opt) => {
                    const alreadyAdded = sortedHostGroups.some(
                      ([, hg]) => hg.backendId === opt.id
                    );
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        className={`tiles-bar-invite-item ${alreadyAdded ? 'disabled' : ''}`}
                        onClick={() => !alreadyAdded && handleAddHost(opt.id)}
                        disabled={alreadyAdded}
                      >
                        {opt.label}
                        {alreadyAdded && <span className="tiles-bar-invite-added">已添加</span>}
                      </button>
                    );
                  })}
                </div>
              )}
              <button
                type="button"
                className="tiles-bar-invite-btn"
                onClick={() => setShowInviteMenu((v) => !v)}
                title="邀请参会人"
              >
                <UserPlus size={20} />
              </button>
            </div>
          )}
        </div>

        {/* Collapse button */}
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
    </aside>
  );
});

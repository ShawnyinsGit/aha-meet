import { memo, useMemo } from 'react';
import { UserPlus } from 'lucide-react';
import { useState, useCallback } from 'react';
import type { HostGroupState, WorkerState } from '../lib/meeting-store';

interface ParticipantPanelProps {
  workers: WorkerState[];
  hostGroups: Map<string, HostGroupState>;
  running: boolean;
  aiSpeaking: boolean;
  selfTile: React.ReactNode;
  onAddHost?: (backendId: string) => void;
}

const BACKEND_LABELS: Record<string, string> = {
  'claude-code': 'Claude',
  'codex': 'Codex',
  'kimi': 'Kimi',
  'qoder': 'Qoder',
};

const BACKEND_ICONS: Record<string, string> = {
  'claude-code': 'C',
  'codex': 'X',
  'kimi': 'K',
  'qoder': 'Q',
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

  // Find the talker worker for each host group.
  const hostTalkers = useMemo(() => {
    const map = new Map<string, WorkerState>();
    for (const w of workers) {
      if (w.role === 'talker') map.set(w.hostId || 'default', w);
    }
    return map;
  }, [workers]);

  // Sort host groups: 'default' first, then alphabetically.
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

  const getAvatarLetter = (backendId: string): string => {
    return BACKEND_ICONS[backendId] ?? backendId.charAt(0).toUpperCase();
  };

  const getAvatarColor = (backendId: string): string => {
    const colors: Record<string, string> = {
      'claude-code': '#d97757',
      'codex': '#10a37f',
      'kimi': '#5b6ef5',
      'qoder': '#9333ea',
    };
    return colors[backendId] ?? '#6b7280';
  };

  return (
    <div className="participant-bar">
      {/* Self tile */}
      <div className="participant-tile self-tile">{selfTile}</div>

      {/* Host tiles */}
      {sortedHostGroups.map(([hostId, hg]) => {
        const talker = hostTalkers.get(hostId);
        const label = BACKEND_LABELS[hg.backendId] ?? hg.backendId;
        const isActive = running && aiSpeaking;

        return (
          <div
            key={hostId}
            className={`participant-tile host-tile ${isActive ? 'speaking' : ''}`}
          >
            <div
              className="host-avatar"
              style={{ backgroundColor: getAvatarColor(hg.backendId) }}
            >
              {getAvatarLetter(hg.backendId)}
            </div>
            <span className="host-label">{label}</span>
            {talker?.pendingPermission && (
              <span className="host-permission-badge">!</span>
            )}
          </div>
        );
      })}

      {/* Invite button */}
      {onAddHost && (
        <div className="invite-wrap">
          {showInviteMenu && (
            <div className="invite-dropdown">
              {BACKEND_OPTIONS.map((opt) => {
                const alreadyAdded = sortedHostGroups.some(
                  ([, hg]) => hg.backendId === opt.id
                );
                return (
                  <button
                    key={opt.id}
                    type="button"
                    className={`invite-item ${alreadyAdded ? 'disabled' : ''}`}
                    onClick={() => !alreadyAdded && handleAddHost(opt.id)}
                    disabled={alreadyAdded}
                  >
                    {opt.label}
                    {alreadyAdded && <span className="invite-added">已添加</span>}
                  </button>
                );
              })}
            </div>
          )}
          <button
            type="button"
            className="invite-tile"
            onClick={() => setShowInviteMenu((v) => !v)}
            title="邀请参会人"
          >
            <UserPlus size={16} />
          </button>
        </div>
      )}
    </div>
  );
});

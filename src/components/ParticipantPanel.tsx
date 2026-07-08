import { memo, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Plus } from 'lucide-react';
import type { HostGroupState, WorkerState } from '../lib/meeting-store';
import { WorkerCard } from './WorkerCard';

interface ParticipantPanelProps {
  workers: WorkerState[];
  hostGroups: Map<string, HostGroupState>;
  aiSpeaking: boolean;
  selfTile: React.ReactNode;
  onResolvePermission: (id: string, decision: 'allow' | 'deny') => void;
  onOpenParticipantsTab?: () => void;
}

export const ParticipantPanel = memo(function ParticipantPanel({
  workers,
  hostGroups,
  aiSpeaking,
  selfTile,
  onResolvePermission,
  onOpenParticipantsTab,
}: ParticipantPanelProps) {
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

  return (
    <aside className="tiles-gallery">
      <div className={`tiles-gallery-scroll ${barCollapsed ? 'tiles-gallery-collapsed' : ''}`}>
        {/* Self tile */}
        <div className="tiles-gallery-self">{selfTile}</div>

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
              onResolvePermission={onResolvePermission}
            />
          );
        })}

        {/* Invite button - opens participants tab */}
        {onOpenParticipantsTab && (
          <button
            type="button"
            className="tiles-gallery-invite-btn"
            onClick={onOpenParticipantsTab}
            title="邀请参会人"
          >
            <Plus size={20} />
          </button>
        )}
      </div>

      {/* Collapse button - bottom center */}
      <button
        type="button"
        className="tiles-gallery-collapse"
        onClick={() => setBarCollapsed((v) => !v)}
        aria-label={barCollapsed ? '展开参会人' : '收起参会人'}
        title={barCollapsed ? '展开参会人' : '收起参会人'}
      >
        {barCollapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
      </button>
    </aside>
  );
});

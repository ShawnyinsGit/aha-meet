import type { ReactNode } from 'react';

interface ParticipantTileProps {
  name: string;
  role: string;
  initials: string;
  variant: 'self' | 'ai';
  speaking?: boolean;
  status?: string;
  muted?: boolean;
  avatar?: ReactNode;
}

export function ParticipantTile({ name, role, initials, variant, speaking, status, muted, avatar }: ParticipantTileProps) {
  return (
    <div className={`tile tile-${variant} ${speaking ? 'tile-speaking' : ''}`}>
      <div className="tile-stage">
        <div className={`avatar avatar-${variant} ${avatar ? 'avatar-custom' : ''}`}>
          {avatar ?? <span>{initials}</span>}
          {speaking && <span className="avatar-pulse" />}
        </div>
        {status && <div className="tile-status">{status}</div>}
      </div>
      <div className="tile-footer">
        <span className="tile-name">{name}</span>
        <span className="tile-role">{role}</span>
        {muted && <span className="tile-muted">muted</span>}
      </div>
    </div>
  );
}

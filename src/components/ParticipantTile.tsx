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
  /** Dynamic bottom line: last spoken text, current task, etc. */
  bottomText?: string;
}

export function ParticipantTile({
  name,
  role,
  initials,
  variant,
  speaking,
  status,
  muted,
  avatar,
  bottomText,
}: ParticipantTileProps) {
  return (
    <div className={`tile tile-${variant} ${speaking ? 'tile-speaking' : ''}`}>
      {/* Role badge — top-right corner */}
      <div className="tile-role-badge">{role}</div>

      <div className="tile-stage">
        <div className={`avatar avatar-${variant} ${avatar ? 'avatar-custom' : ''}`}>
          {avatar ?? <span>{initials}</span>}
          {speaking && <span className="avatar-pulse" />}
        </div>
        {/* Status sits just below the avatar */}
        {status && <div className="tile-status">{status}</div>}
      </div>

      {/* Bottom line: dynamic context text */}
      <div className="tile-footer">
        <span className="tile-bottom-text" title={bottomText ?? name}>
          {bottomText ?? name}
        </span>
        {muted && <span className="tile-muted">muted</span>}
      </div>
    </div>
  );
}

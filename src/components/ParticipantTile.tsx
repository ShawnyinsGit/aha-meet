import type { KeyboardEvent, ReactNode } from 'react';

interface ParticipantTileProps {
  name: string;
  role: string;
  initials: string;
  variant: 'self' | 'ai';
  speaking?: boolean;
  status?: string;
  muted?: boolean;
  avatar?: ReactNode;
  /** Optional click handler — turns the tile into a button. */
  onClick?: () => void;
  /** Optional aria-label for the clickable surface. */
  ariaLabel?: string;
  /** Selection ring (matches WorkerCard `worker-card-selected` look). */
  selected?: boolean;
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
  onClick,
  ariaLabel,
  selected,
}: ParticipantTileProps) {
  const interactive = Boolean(onClick);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!onClick) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };

  const className = [
    'tile',
    `tile-${variant}`,
    speaking ? 'tile-speaking' : '',
    interactive ? 'tile-interactive' : '',
    selected ? 'tile-selected' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={className}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={interactive ? handleKeyDown : undefined}
      aria-label={interactive ? ariaLabel ?? name : undefined}
    >
      {/* Role badge — top-right corner */}
      <div className="tile-role-badge">{role}</div>

      {/* Muted chip — top-left corner overlay (footer is gone) */}
      {muted && <div className="tile-muted-chip">Muted</div>}

      <div className="tile-stage tile-stage-centered">
        <div className={`avatar avatar-${variant} ${avatar ? 'avatar-custom' : ''}`}>
          {avatar ?? <span>{initials}</span>}
          {speaking && <span className="avatar-pulse" />}
        </div>
        {status && <div className="tile-status">{status}</div>}
      </div>
    </div>
  );
}

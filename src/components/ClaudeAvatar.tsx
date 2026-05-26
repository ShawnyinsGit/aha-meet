interface ClaudeAvatarProps {
  size?: number;
  speaking?: boolean;
  className?: string;
}

export function ClaudeAvatar({ size = 88, speaking, className }: ClaudeAvatarProps) {
  const stroke = Math.max(1.2, size * 0.018);
  return (
    <svg
      className={`claude-avatar-svg ${speaking ? 'claude-avatar-svg-speaking' : ''} ${className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label="Claude"
    >
      <defs>
        <radialGradient id="claudeOrb" cx="38%" cy="34%" r="78%">
          <stop offset="0%" stopColor="#ffd5b0" />
          <stop offset="40%" stopColor="#f59670" />
          <stop offset="78%" stopColor="#cf5a3a" />
          <stop offset="100%" stopColor="#7a2a1c" />
        </radialGradient>
        <radialGradient id="claudeHighlight" cx="32%" cy="28%" r="32%">
          <stop offset="0%" stopColor="rgba(255,255,255,0.85)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </radialGradient>
        <linearGradient id="claudeRing" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="rgba(255,210,180,0.65)" />
          <stop offset="100%" stopColor="rgba(255,120,90,0.25)" />
        </linearGradient>
      </defs>

      <circle cx="50" cy="50" r="46" fill="url(#claudeRing)" opacity="0.55" />
      <circle cx="50" cy="50" r="40" fill="url(#claudeOrb)" />
      <circle cx="50" cy="50" r="40" fill="url(#claudeHighlight)" />

      {/* Anthropic-style ray motif */}
      <g
        stroke="rgba(255,247,238,0.92)"
        strokeWidth={stroke}
        strokeLinecap="round"
        fill="none"
        transform="translate(50 50)"
      >
        <line x1="0" y1="-22" x2="0" y2="-12" />
        <line x1="0" y1="22" x2="0" y2="12" />
        <line x1="-22" y1="0" x2="-12" y2="0" />
        <line x1="22" y1="0" x2="12" y2="0" />
        <line x1="-15.5" y1="-15.5" x2="-8.5" y2="-8.5" />
        <line x1="15.5" y1="-15.5" x2="8.5" y2="-8.5" />
        <line x1="-15.5" y1="15.5" x2="-8.5" y2="8.5" />
        <line x1="15.5" y1="15.5" x2="8.5" y2="8.5" />
      </g>
      <circle cx="50" cy="50" r="4.5" fill="rgba(255,247,238,0.95)" />
    </svg>
  );
}

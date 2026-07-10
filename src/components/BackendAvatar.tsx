interface BackendAvatarProps {
  iconId: string;
  size?: number;
  speaking?: boolean;
  customAvatar?: string | null;
  className?: string;
}

/** Map of iconId to bundled default icon path (resolved at build time via Vite). */
const DEFAULT_ICONS: Record<string, string> = {
  claude: new URL('../assets/cli-icons/Claude.gif', import.meta.url).href,
  codex: new URL('../assets/cli-icons/codex.jpeg', import.meta.url).href,
  kimi: new URL('../assets/cli-icons/kimi.jpeg', import.meta.url).href,
  qoder: new URL('../assets/cli-icons/qoder.png', import.meta.url).href,
};

/** Per-backend avatar rendered at talker size. Falls back to a generic orb. */
export function BackendAvatar({ iconId, size = 56, speaking, customAvatar, className }: BackendAvatarProps) {
  // Custom avatar override (uploaded image)
  if (customAvatar) {
    return (
      <img
        className={`backend-avatar-img ${speaking ? 'backend-avatar-speaking' : ''} ${className ?? ''}`}
        src={customAvatar}
        width={size}
        height={size}
        alt={iconId}
        draggable={false}
      />
    );
  }

  // Bundled default icon
  const defaultIcon = DEFAULT_ICONS[iconId];
  if (defaultIcon) {
    return (
      <img
        className={`backend-avatar-img ${speaking ? 'backend-avatar-speaking' : ''} ${className ?? ''}`}
        src={defaultIcon}
        width={size}
        height={size}
        alt={iconId}
        draggable={false}
      />
    );
  }

  // Fallback: generic orb with initial
  return <GenericAvatar size={size} speaking={speaking} className={className} label={iconId} />;
}

/* ── Generic fallback ───────────────────────────────────────────────── */

function GenericAvatar({ size, speaking, className, label }: { size: number; speaking?: boolean; className?: string; label: string }) {
  const initial = label.trim().charAt(0).toUpperCase() || '?';
  return (
    <svg
      className={`backend-avatar-svg ${speaking ? 'backend-avatar-speaking' : ''} ${className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label={label}
    >
      <defs>
        <radialGradient id="ba-generic-orb" cx="38%" cy="34%" r="78%">
          <stop offset="0%" stopColor="#e2e8f0" />
          <stop offset="50%" stopColor="#94a3b8" />
          <stop offset="100%" stopColor="#334155" />
        </radialGradient>
      </defs>
      <circle cx="50" cy="50" r="46" fill="rgba(100,116,139,0.15)" />
      <circle cx="50" cy="50" r="40" fill="url(#ba-generic-orb)" />
      <text x="50" y="58" textAnchor="middle" fontSize="36" fontWeight="600" fill="white" fontFamily="system-ui, sans-serif">
        {initial}
      </text>
    </svg>
  );
}

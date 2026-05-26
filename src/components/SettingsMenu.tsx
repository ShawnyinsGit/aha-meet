// SettingsMenu — gear button in MeetingHeader that opens a popover with all
// of the meeting-level toggles (voice lock, voice picker, memory). Used to
// live inline in the SideDrawer but was crowding the chat surface.

import { useEffect, useRef, useState, type ReactNode } from 'react';

interface SettingsMenuProps {
  children: ReactNode;
  // Optional badge dot on the gear (e.g. when something needs attention).
  badge?: boolean;
}

export function SettingsMenu({ children, badge = false }: SettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t)) return;
      if (btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="settings-menu">
      <button
        ref={btnRef}
        type="button"
        className={`mtg-icon-btn settings-menu-btn ${open ? 'active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="设置"
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        ⚙
        {badge && <span className="settings-menu-badge" />}
      </button>
      {open && (
        <div
          className="settings-popover"
          ref={popRef}
          role="dialog"
          aria-label="设置"
        >
          {children}
        </div>
      )}
    </div>
  );
}

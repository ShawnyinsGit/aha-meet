// SettingsMenu — gear button in MeetingHeader that opens a modal with all
// of the meeting-level toggles (voice lock, voice picker, memory).
// Redesigned from popover to modal for better usability and visual hierarchy.

import { useEffect, useRef, useState, type ReactNode } from 'react';

interface SettingsMenuProps {
  children: ReactNode;
  // Optional badge dot on the gear (e.g. when something needs attention).
  badge?: boolean;
}

export function SettingsMenu({ children, badge = false }: SettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const modalRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="mtg-icon-btn settings-menu-btn"
        onClick={() => setOpen(true)}
        title="设置"
        aria-haspopup="dialog"
      >
        ⚙
        {badge && <span className="settings-menu-badge" />}
      </button>
      {open && (
        <>
          <div
            className="settings-modal-backdrop"
            onClick={() => setOpen(false)}
          />
          <div
            className="settings-modal"
            ref={modalRef}
            role="dialog"
            aria-label="设置"
            aria-modal="true"
          >
            <div className="settings-modal-header">
              <h2 className="settings-modal-title">设置</h2>
              <button
                type="button"
                className="settings-modal-close"
                onClick={() => setOpen(false)}
                aria-label="关闭设置"
              >
                ✕
              </button>
            </div>
            <div className="settings-modal-body">
              {children}
            </div>
          </div>
        </>
      )}
    </>
  );
}

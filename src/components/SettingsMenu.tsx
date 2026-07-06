// SettingsMenu — gear button in MeetingHeader that opens the settings in a
// standalone Electron window (separate from the main app, opaque background).
// The in-page modal flow has been removed; clicking the gear calls
// settingsWindow.open() on the main process.

interface SettingsMenuProps {
  badge?: boolean;
}

export function SettingsMenu({ badge = false }: SettingsMenuProps) {
  const handleClick = () => {
    void window.vibeMeet.settingsWindow.open();
  };

  return (
    <button
      type="button"
      className="mtg-icon-btn settings-menu-btn"
      onClick={handleClick}
      title="设置"
    >
      ⚙
      {badge && <span className="settings-menu-badge" />}
    </button>
  );
}

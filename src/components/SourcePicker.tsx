import { useCallback, useEffect, useState } from 'react';
import { X, Lock } from 'lucide-react';
import type { DesktopSource } from '../types';
import { errorMessage } from '../lib/format-error';

interface SourcePickerProps {
  open: boolean;
  onClose: () => void;
  onPick: (source: DesktopSource) => void;
}

type PickerError = { kind: 'permission'; status: string } | { kind: 'other'; message: string };

export function SourcePicker({ open, onClose, onPick }: SourcePickerProps) {
  const [sources, setSources] = useState<DesktopSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<PickerError | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSources([]);
    try {
      const res = await window.vibeMeet.getDesktopSources();
      if (!res.ok) {
        if (res.error === 'permission-denied' || res.status === 'denied' || res.status === 'restricted' || res.status === 'not-determined') {
          setError({ kind: 'permission', status: res.status });
        } else {
          setError({ kind: 'other', message: res.error });
        }
        return;
      }
      setSources(res.sources);
    } catch (err: unknown) {
      setError({ kind: 'other', message: errorMessage(err) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const openSettings = useCallback(() => {
    window.vibeMeet.openScreenSettings();
  }, []);

  if (!open) return null;

  return (
    <div className="picker-backdrop" onClick={onClose}>
      <div className="picker" onClick={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <span>Choose what to share with Claude</span>
          <button className="picker-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        {error?.kind === 'permission' && (
          <div className="picker-permission">
            <div className="picker-permission-icon" aria-hidden="true"><Lock size={28} /></div>
            <div className="picker-permission-title">Screen recording permission needed</div>
            <div className="picker-permission-text">
              macOS needs your permission for AhaMeet to capture the screen. Open System Settings,
              enable AhaMeet under <b>Privacy &amp; Security → Screen Recording</b>, then{' '}
              <b>quit and reopen</b> the app (macOS requires a relaunch for the new permission to take effect).
            </div>
            <div className="picker-permission-actions">
              <button className="picker-btn picker-btn-primary" onClick={openSettings}>
                Open System Settings
              </button>
              <button className="picker-btn" onClick={load}>Try again</button>
            </div>
          </div>
        )}

        {error?.kind === 'other' && (
          <div className="picker-error">
            <div>{error.message}</div>
            <button className="picker-btn" onClick={load}>Retry</button>
          </div>
        )}

        {!error && loading && <div className="picker-loading">Loading sources…</div>}

        {!error && !loading && (
          <div className="picker-grid">
            {sources.length === 0 ? (
              <div className="picker-empty">No sources found.</div>
            ) : (
              sources.map((s) => (
                <button key={s.id} className="picker-item" onClick={() => { onPick(s); onClose(); }}>
                  <img src={s.thumbnail} alt={s.name} />
                  <div className="picker-item-name" title={s.name}>{s.name}</div>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

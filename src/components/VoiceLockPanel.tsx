// VoiceLockPanel — settings UI for the "only listen to me" gate.
//
// State machine:
//   idle (not enrolled) → recording → idle (enrolled)
//   idle (enrolled) → toggle on/off, re-record, clear
//   recording → cancel → idle (previous enrollment preserved)

import { useEffect, useState } from 'react';
import { Mic, Lock } from 'lucide-react';

interface EnrollmentProgress {
  targetSeconds: number;
  capturedSeconds: number;
  segments: number;
}

// Transient feedback after the user finishes (or aborts) an enrollment run.
// `saved` — voice print persisted, gate is now active.
// `tooShort` — stop pressed before enough clean speech accumulated, nothing saved.
// `cancelled` — stop pressed with no captured samples at all.
export type EnrollmentToast = 'saved' | 'tooShort' | 'cancelled' | null;

interface VoiceLockPanelProps {
  enabled: boolean;
  enrolledAt: number | null;
  modelMatches: boolean;
  // null when not currently recording.
  enrollment: EnrollmentProgress | null;
  // UI hint: shown briefly after the gate drops a non-matching segment.
  recentlyRejected: boolean;
  // UI hint: result of the last enrollment run (auto-finalize or stop).
  enrollmentToast: EnrollmentToast;
  onToggleEnabled: () => void;
  onStartEnroll: () => void;
  onCancelEnroll: () => void;
  onClearEnrollment: () => void;
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function VoiceLockPanel({
  enabled,
  enrolledAt,
  modelMatches,
  enrollment,
  recentlyRejected,
  enrollmentToast,
  onToggleEnabled,
  onStartEnroll,
  onCancelEnroll,
  onClearEnrollment,
}: VoiceLockPanelProps) {
  const enrolled = enrolledAt != null && modelMatches;
  // Force a re-render every 30s so the "X min ago" label stays fresh.
  const [, force] = useState(0);
  useEffect(() => {
    if (!enrolled) return;
    const id = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [enrolled]);

  if (enrollment) {
    const pct = Math.min(100, (enrollment.capturedSeconds / enrollment.targetSeconds) * 100);
    const waiting = enrollment.segments === 0 && enrollment.capturedSeconds === 0;
    return (
      <div className="drawer-settings drawer-settings-armed">
        <div className="drawer-settings-row">
          <div className="drawer-settings-label">
            <div className="drawer-settings-title voice-lock-title">
              <Mic size={14} aria-hidden="true" />
              <span>{waiting ? '等待麦克风启动…' : '正在录入声纹…'}</span>
            </div>
            <div className="drawer-settings-hint">
              {waiting
                ? '对着麦克风说话即可开始 · 共需 8 秒清晰语音'
                : `已采集 ${enrollment.capturedSeconds.toFixed(1)}s / ${enrollment.targetSeconds}s · ${enrollment.segments} 段`}
            </div>
          </div>
          <button
            type="button"
            className="voice-lock-cancel"
            onClick={onCancelEnroll}
            title="停止录入(已采集的样本会丢弃)"
          >
            停止
          </button>
        </div>
        <div style={{ height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2, marginTop: 8, overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: '#7cc6ff', transition: 'width 200ms ease' }} />
        </div>
      </div>
    );
  }

  return (
    <div className={`drawer-settings ${enabled ? 'drawer-settings-armed' : ''}`}>
      <div className="drawer-settings-row">
        <div className="drawer-settings-label">
          <div className="drawer-settings-title voice-lock-title">
            {enabled && <Lock size={14} aria-hidden="true" />}
            <span>声纹锁定 · Voice lock</span>
            {recentlyRejected && (
              <span style={{ marginLeft: 8, fontSize: 11, color: '#ffb86b' }}>· ignored other voice</span>
            )}
            {enrollmentToast === 'saved' && (
              <span style={{ marginLeft: 8, fontSize: 11, color: '#7cc6ff' }}>· 声纹已保存</span>
            )}
            {enrollmentToast === 'tooShort' && (
              <span style={{ marginLeft: 8, fontSize: 11, color: '#ffb86b' }}>· 录音不足 2 秒,未保存</span>
            )}
            {enrollmentToast === 'cancelled' && (
              <span style={{ marginLeft: 8, fontSize: 11, color: '#9aa4b2' }}>· 已取消</span>
            )}
          </div>
          <div className="drawer-settings-hint">
            {!enrolled
              ? 'Record a sample of your voice so Claude only listens to you.'
              : enabled
                ? `Enrolled ${formatRelative(enrolledAt!)} · only your voice is transcribed.`
                : `Enrolled ${formatRelative(enrolledAt!)} · turn on to filter other voices.`}
            {enrolledAt != null && !modelMatches && (
              <span style={{ color: '#ff7a7a' }}> · model changed, re-enrollment required</span>
            )}
          </div>
        </div>
        <button
          className={`drawer-toggle ${enabled ? 'drawer-toggle-on' : ''}`}
          role="switch"
          aria-checked={enabled}
          onClick={onToggleEnabled}
          disabled={!enrolled}
          title={!enrolled ? 'Record your voice first' : enabled ? 'Disable voice lock' : 'Enable voice lock'}
          style={!enrolled ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
        >
          <span className="drawer-toggle-knob" />
        </button>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button
          className="drawer-toggle"
          onClick={onStartEnroll}
          style={{ width: 'auto', padding: '4px 10px', fontSize: 12 }}
          title="Record a fresh voice print"
        >
          <span style={{ padding: '0 4px' }}>{enrolled ? 'Re-record' : 'Record voice (8s)'}</span>
        </button>
        {enrolled && (
          <button
            className="drawer-toggle"
            onClick={onClearEnrollment}
            style={{ width: 'auto', padding: '4px 10px', fontSize: 12 }}
            title="Forget the saved voice print"
          >
            <span style={{ padding: '0 4px' }}>Clear</span>
          </button>
        )}
      </div>
    </div>
  );
}

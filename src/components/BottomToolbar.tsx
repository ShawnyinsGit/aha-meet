import type { ReactNode } from 'react';
import {
  Mic,
  MicOff,
  AudioLines,
  RefreshCw,
  Volume2,
  VolumeX,
  Monitor,
  MonitorUp,
  Camera,
  Square,
  MessageSquare,
  X,
} from 'lucide-react';
import type { MicrophoneCaptureStatus } from '../lib/microphone-ui-state';

interface BottomToolbarProps {
  muted: boolean;
  onToggleMute: () => void;
  micSupported: boolean;
  listening: boolean;
  speechLevel?: number;
  asrMode?: 'whisper' | 'browser' | 'probing';
  micStatus: MicrophoneCaptureStatus;
  micRetryable: boolean;
  onRetryMic: () => void;
  ttsOn: boolean;
  onToggleTts: () => void;
  sharing: boolean;
  onToggleShare: () => void;
  snapshotEnabled: boolean;
  onSnapshot: () => void;
  onInterrupt: () => void;
  chatOpen: boolean;
  onToggleChat: () => void;
  onLeave: () => void;
}

interface ToolbarButtonProps {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  warning?: boolean;
  title?: string;
}

const ICON_SIZE = 20;

function ToolbarButton({ icon, label, onClick, active, danger, disabled, warning, title }: ToolbarButtonProps) {
  const cls = [
    'tb-btn',
    active && 'tb-btn-active',
    danger && 'tb-btn-danger',
    warning && 'tb-btn-warn',
    disabled && 'tb-btn-disabled',
  ].filter(Boolean).join(' ');
  return (
    <button className={cls} onClick={onClick} disabled={disabled} title={title}>
      <span className="tb-btn-icon" aria-hidden="true">{icon}</span>
      <span className="tb-btn-label">{label}</span>
    </button>
  );
}

export function BottomToolbar({
  muted,
  onToggleMute,
  micSupported,
  listening,
  speechLevel = 0,
  asrMode = 'probing',
  micStatus,
  micRetryable,
  onRetryMic,
  ttsOn,
  onToggleTts,
  sharing,
  onToggleShare,
  snapshotEnabled,
  onSnapshot,
  onInterrupt,
  chatOpen,
  onToggleChat,
  onLeave,
}: BottomToolbarProps) {
  const meterWidth = Math.max(0, Math.min(1, speechLevel)) * 100;
  const asrBadge = asrMode === 'whisper' ? 'Whisper' : asrMode === 'browser' ? 'Browser SR' : '…';
  const micBusy = micStatus === 'requesting-permission' || micStatus === 'initializing';
  const micIcon = micRetryable
    ? <RefreshCw size={ICON_SIZE} />
    : muted
      ? <MicOff size={ICON_SIZE} />
      : listening
        ? <AudioLines size={ICON_SIZE} />
        : <Mic size={ICON_SIZE} />;
  const micLabel = micRetryable
    ? 'Retry mic'
    : micBusy
      ? 'Starting…'
      : muted
        ? 'Unmute'
        : listening
          ? 'Listening'
          : 'Mic';
  return (
    <div className="toolbar">
      <div className="toolbar-group">
        <div className="tb-mic-cluster">
          <ToolbarButton
            icon={micIcon}
            label={micLabel}
            onClick={micRetryable ? onRetryMic : onToggleMute}
            active={!muted && listening}
            warning={muted || micRetryable}
            disabled={!micSupported}
            title={micRetryable ? 'Microphone failed to start. Click to retry.' : undefined}
          />
          <div className="tb-mic-meter" aria-hidden="true">
            <div
              className="tb-mic-meter-fill"
              style={{ width: `${muted ? 0 : meterWidth}%` }}
            />
          </div>
          <span className="tb-asr-badge" title={`ASR backend: ${asrBadge}`}>{asrBadge}</span>
        </div>
        <ToolbarButton
          icon={ttsOn ? <Volume2 size={ICON_SIZE} /> : <VolumeX size={ICON_SIZE} />}
          label={ttsOn ? 'Voice on' : 'Voice off'}
          onClick={onToggleTts}
          active={ttsOn}
        />
      </div>

      <div className="toolbar-group toolbar-group-primary">
        <ToolbarButton
          icon={sharing ? <Monitor size={ICON_SIZE} /> : <MonitorUp size={ICON_SIZE} />}
          label={sharing ? 'Stop sharing' : 'Share my screen'}
          onClick={onToggleShare}
          active={sharing}
          danger={sharing}
        />
        <ToolbarButton
          icon={<Camera size={ICON_SIZE} />}
          label={sharing ? 'Send snapshot' : 'Snapshot (share first)'}
          onClick={onSnapshot}
          disabled={!snapshotEnabled}
        />
        <ToolbarButton
          icon={<Square size={ICON_SIZE} />}
          label="Interrupt"
          onClick={onInterrupt}
        />
      </div>

      <div className="toolbar-group">
        <ToolbarButton
          icon={<MessageSquare size={ICON_SIZE} />}
          label="Chat"
          onClick={onToggleChat}
          active={chatOpen}
        />
        <button className="tb-leave" onClick={onLeave}>
          <span className="tb-btn-icon" aria-hidden="true"><X size={ICON_SIZE} /></span>
          <span className="tb-btn-label">Leave</span>
        </button>
      </div>
    </div>
  );
}

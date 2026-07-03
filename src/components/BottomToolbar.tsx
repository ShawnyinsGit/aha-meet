import type { ReactNode } from 'react';
import {
  Mic,
  MicOff,
  AudioLines,
  Volume2,
  VolumeX,
  Monitor,
  MonitorUp,
  Camera,
  Square,
  MessageSquare,
  X,
} from 'lucide-react';

interface BottomToolbarProps {
  muted: boolean;
  onToggleMute: () => void;
  micSupported: boolean;
  listening: boolean;
  speechLevel?: number;
  asrMode?: 'whisper' | 'browser' | 'probing';
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
}

const ICON_SIZE = 20;

function ToolbarButton({ icon, label, onClick, active, danger, disabled, warning }: ToolbarButtonProps) {
  const cls = [
    'tb-btn',
    active && 'tb-btn-active',
    danger && 'tb-btn-danger',
    warning && 'tb-btn-warn',
    disabled && 'tb-btn-disabled',
  ].filter(Boolean).join(' ');
  return (
    <button className={cls} onClick={onClick} disabled={disabled}>
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
  const micIcon = muted ? <MicOff size={ICON_SIZE} /> : listening ? <AudioLines size={ICON_SIZE} /> : <Mic size={ICON_SIZE} />;
  return (
    <div className="toolbar">
      <div className="toolbar-group">
        <div className="tb-mic-cluster">
          <ToolbarButton
            icon={micIcon}
            label={muted ? 'Unmute' : listening ? 'Listening' : 'Mic'}
            onClick={onToggleMute}
            active={!muted && listening}
            warning={muted}
            disabled={!micSupported}
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
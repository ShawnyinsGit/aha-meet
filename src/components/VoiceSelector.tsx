// Dropdown that lets the user pick which Chinese voice Claude speaks with.
// Lives in the SideDrawer's topSlot alongside the voice-lock panel.
//
// "Auto" = let useSpeech's rankVoice pick the best installed voice. Any
// explicit pick overrides it and persists across launches.

import { listChineseVoices, tierLabel, type ListedVoice } from '../lib/voice-quality';
import type { SpeechFilterMode } from '../lib/speech-format';

interface VoiceSelectorProps {
  voices: SpeechSynthesisVoice[];
  selectedVoiceName: string | null;
  onChange: (name: string | null) => void;
  onOpenGuide: () => void;
  filterMode: SpeechFilterMode;
  onChangeFilterMode: (mode: SpeechFilterMode) => void;
}

function describeVoice(v: ListedVoice): string {
  const tier = v.tier === 'default' ? '默认' : tierLabel(v.tier);
  return `${v.label} · ${v.localeLabel} · ${tier}`;
}

export function VoiceSelector({
  voices,
  selectedVoiceName,
  onChange,
  onOpenGuide,
  filterMode,
  onChangeFilterMode,
}: VoiceSelectorProps) {
  const chineseVoices = listChineseVoices(voices);
  const hasPremium = chineseVoices.some((v) => v.tier !== 'default');
  const strict = filterMode === 'strict';

  return (
    <div className="drawer-settings">
      <div className="drawer-settings-row">
        <div className="drawer-settings-label">
          <div className="drawer-settings-title">中文播报音色</div>
          <div className="drawer-settings-hint">
            {chineseVoices.length === 0
              ? '没检测到中文音色,会用浏览器默认引擎'
              : hasPremium
                ? '已检测到优质音色,可在下方切换'
                : '只有系统默认机器音,建议下载 Siri 中文音色'}
          </div>
        </div>
        {!hasPremium && chineseVoices.length > 0 && (
          <button
            type="button"
            className="voice-select-guide voice-select-guide-inline"
            onClick={onOpenGuide}
          >
            更多音色
          </button>
        )}
      </div>

      <select
        className="voice-select"
        value={selectedVoiceName ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        disabled={chineseVoices.length === 0}
      >
        <option value="">自动(推荐最优)</option>
        {chineseVoices.map((v) => (
          <option key={v.voice.name} value={v.voice.name}>
            {describeVoice(v)}
          </option>
        ))}
      </select>

      <div className="drawer-settings-row" style={{ marginTop: 12 }}>
        <div className="drawer-settings-label">
          <div className="drawer-settings-title">播报过滤</div>
          <div className="drawer-settings-hint">
            {strict
              ? '英文段和工具调用不念出来'
              : '原样播报,包括英文思考和工具名'}
          </div>
        </div>
        <button
          type="button"
          className={`drawer-toggle ${strict ? 'drawer-toggle-on' : ''}`}
          aria-pressed={strict}
          onClick={() => onChangeFilterMode(strict ? 'off' : 'strict')}
        >
          <span className="drawer-toggle-knob" />
        </button>
      </div>
    </div>
  );
}

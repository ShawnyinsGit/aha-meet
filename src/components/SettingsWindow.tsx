// SettingsWindow — standalone settings page loaded in its own BrowserWindow
// via ?view=settings. Opaque solid background, no glass/transparency.
// Hosts all settings panels: Memory, Voice, VoiceLock, Skills.

import { useCallback } from 'react';
import { useVoicePreferences } from '../hooks/useVoicePreferences';
import { useVoiceLock } from '../hooks/useVoiceLock';
import { MemoryPanel } from './MemoryPanel';
import { VoiceSelector } from './VoiceSelector';
import { VoiceLockPanel } from './VoiceLockPanel';
import { SkillManagerPanel } from './SkillManagerPanel';
import { VoiceGuideModal } from './VoiceGuideModal';
import { SPEAKER_MODEL_ID } from '../lib/speaker-embedding';

// Dummy refs/callbacks for useVoiceLock — the settings window has no active
// audio session, so mute/speaking state is irrelevant. The hook still needs
// these arguments for type correctness and to update its own enrollment state.
const noopSetState = () => {};
const dummySpeakingRef = { current: false };

export function SettingsWindow() {
  const voicePrefs = useVoicePreferences();
  const voiceLock = useVoiceLock({
    muted: false,
    setMuted: noopSetState,
    setAiSpeaking: noopSetState,
    speakingRef: dummySpeakingRef,
  });

  const handleClose = useCallback(() => {
    void window.vibeMeet.settingsWindow.close();
  }, []);

  return (
    <div className="settings-window">
      <header className="settings-window-header">
        <h1 className="settings-window-title">设置</h1>
        <button
          type="button"
          className="settings-window-close"
          onClick={handleClose}
          aria-label="关闭设置"
        >
          ✕
        </button>
      </header>
      <div className="settings-window-body">
        <MemoryPanel />
        <VoiceSelector
          voices={voicePrefs.voices}
          selectedVoiceName={voicePrefs.selectedVoiceName}
          onChange={voicePrefs.handleVoiceChange}
          onOpenGuide={voicePrefs.handleOpenGuide}
          filterMode={voicePrefs.filterMode}
          onChangeFilterMode={voicePrefs.handleFilterModeChange}
          voicePolishEnabled={voicePrefs.voicePolishEnabled}
          onChangeVoicePolish={voicePrefs.handleVoicePolishChange}
        />
        <VoiceLockPanel
          enabled={voiceLock.voiceLockEnabled}
          enrolledAt={voiceLock.voicePrint?.enrolledAt ?? null}
          modelMatches={voiceLock.voicePrint?.model === SPEAKER_MODEL_ID}
          enrollment={voiceLock.enrollment}
          recentlyRejected={voiceLock.recentlyRejected}
          enrollmentToast={voiceLock.enrollmentToast}
          onToggleEnabled={voiceLock.handleToggleVoiceLock}
          onStartEnroll={voiceLock.handleStartEnrollment}
          onCancelEnroll={voiceLock.handleCancelEnrollment}
          onClearEnrollment={voiceLock.handleClearEnrollment}
        />
        <SkillManagerPanel />
      </div>
      {voicePrefs.guideOpen && (
        <VoiceGuideModal
          open={voicePrefs.guideOpen}
          onClose={voicePrefs.handleGuideClose}
          onDismissForever={voicePrefs.handleDismissForever}
        />
      )}
    </div>
  );
}

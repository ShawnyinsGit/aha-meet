import { useCallback, useEffect, useState } from 'react';
import { setSelectedVoiceName, setSpeechFilterMode, useVoices, warmupTTS } from './useSpeech';
import type { SpeechFilterMode } from '../lib/speech-format';
import { hasPremiumChineseVoice, listChineseVoices } from '../lib/voice-quality';

export function useVoicePreferences() {
  const [selectedVoiceName, setSelectedVoiceNameState] = useState<string | null>(null);
  const [guidanceDismissed, setGuidanceDismissed] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [guidanceClosedThisSession, setGuidanceClosedThisSession] = useState(false);
  const [filterMode, setFilterModeState] = useState<SpeechFilterMode>('strict');
  const [voicePolishEnabled, setVoicePolishEnabled] = useState(false);
  const [reportModeEnabled, setReportModeEnabled] = useState(false);

  const { voices, ready: voicesReady } = useVoices();
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

  useEffect(() => {
    let cancelled = false;
    window.vibeMeet.getVoicePref().then((pref) => {
      if (cancelled) return;
      setSelectedVoiceNameState(pref.selectedVoiceName);
      setGuidanceDismissed(pref.guidanceDismissed);
      setFilterModeState(pref.speechFilterMode);
      setVoicePolishEnabled(pref.voicePolishEnabled);
      setReportModeEnabled(pref.reportModeEnabled);
      setSelectedVoiceName(pref.selectedVoiceName);
      setSpeechFilterMode(pref.speechFilterMode);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!voicesReady) return;
    warmupTTS();
  }, [voicesReady]);

  useEffect(() => {
    if (!isMac || !voicesReady) return;
    const chineseAny = listChineseVoices(voices).length > 0;
    const hasPremium = hasPremiumChineseVoice(voices);
    if (hasPremium) {
      setGuideOpen(false);
      return;
    }
    if (!guidanceDismissed && !guidanceClosedThisSession && chineseAny) {
      setGuideOpen(true);
    }
  }, [isMac, voicesReady, voices, guidanceDismissed, guidanceClosedThisSession]);

  const handleVoiceChange = useCallback((name: string | null) => {
    setSelectedVoiceNameState(name);
    setSelectedVoiceName(name);
    void window.vibeMeet.setVoicePref({ selectedVoiceName: name });
  }, []);

  const handleFilterModeChange = useCallback((mode: SpeechFilterMode) => {
    setFilterModeState(mode);
    setSpeechFilterMode(mode);
    void window.vibeMeet.setVoicePref({ speechFilterMode: mode });
  }, []);

  const handleVoicePolishChange = useCallback((enabled: boolean) => {
    setVoicePolishEnabled(enabled);
    void window.vibeMeet.setVoicePref({ voicePolishEnabled: enabled });
  }, []);

  const handleReportModeChange = useCallback((enabled: boolean) => {
    setReportModeEnabled(enabled);
    void window.vibeMeet.setVoicePref({ reportModeEnabled: enabled });
  }, []);

  const handleOpenGuide = useCallback(() => setGuideOpen(true), []);
  const handleGuideClose = useCallback(() => {
    setGuideOpen(false);
    setGuidanceClosedThisSession(true);
  }, []);
  const handleDismissForever = useCallback(() => {
    setGuidanceDismissed(true);
    setGuidanceClosedThisSession(true);
    setGuideOpen(false);
    void window.vibeMeet.setVoicePref({ guidanceDismissed: true });
  }, []);

  return {
    selectedVoiceName,
    filterMode,
    voicePolishEnabled,
    reportModeEnabled,
    voices,
    voicesReady,
    guideOpen,
    handleVoiceChange,
    handleFilterModeChange,
    handleVoicePolishChange,
    handleReportModeChange,
    handleOpenGuide,
    handleGuideClose,
    handleDismissForever,
  };
}

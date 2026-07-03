import { useEffect } from 'react';
import {
  cancelSpeech,
  enqueueConversational,
  isSpeechActive,
  markTurnComplete,
  speakConversational,
} from './useSpeech';
import type { SpeakHandle } from './useSpeech';

interface UseTtsWiringOptions {
  ttsOn: boolean;
  speakingRef: React.MutableRefObject<boolean>;
  setAiSpeaking: (speaking: boolean | ((prev: boolean) => boolean)) => void;
  setSpeakCallback: (handle: SpeakHandle | null) => void;
}

export function useTtsWiring({ ttsOn, speakingRef, setAiSpeaking, setSpeakCallback }: UseTtsWiringOptions) {
  useEffect(() => {
    if (!ttsOn) {
      setSpeakCallback(null);
      cancelSpeech();
      speakingRef.current = false;
      setAiSpeaking(false);
      return;
    }
    const armSpeaking = () => {
      if (speakingRef.current && !isSpeechActive()) {
        speakingRef.current = false;
        setAiSpeaking(false);
      }
      speakingRef.current = true;
      setAiSpeaking(true);
    };
    const finishSpeaking = () => {
      speakingRef.current = false;
      setAiSpeaking(false);
    };
    const handle: SpeakHandle = {
      supersede: (text, onDone) => {
        armSpeaking();
        speakConversational(text, () => {
          finishSpeaking();
          onDone?.();
        });
      },
      enqueue: (text, turnId, opts, onDone) => {
        if (text.trim().length > 0) armSpeaking();
        enqueueConversational(text, turnId, opts, () => {
          finishSpeaking();
          onDone?.();
        });
      },
      markTurnComplete: (turnId) => {
        markTurnComplete(turnId);
      },
    };
    setSpeakCallback(handle);
    return () => {
      setSpeakCallback(null);
    };
  }, [setSpeakCallback, ttsOn, speakingRef, setAiSpeaking]);
}

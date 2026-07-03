import { useEffect, useRef } from 'react';

export function useSpacebarMute(
  muted: boolean,
  setMuted: (muted: boolean | ((prev: boolean) => boolean)) => void,
) {
  const mutedRef = useRef(muted);
  useEffect(() => { mutedRef.current = muted; }, [muted]);

  useEffect(() => {
    let pressTime = 0;
    let wasMuted = false;
    let spaceDown = false;

    const isTypingTarget = () => {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
      if ((el as HTMLElement).isContentEditable) return true;
      return false;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== ' ' || e.repeat || isTypingTarget()) return;
      e.preventDefault();
      spaceDown = true;
      pressTime = Date.now();
      wasMuted = mutedRef.current;
      if (wasMuted) setMuted(false);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== ' ' || !spaceDown) return;
      e.preventDefault();
      spaceDown = false;
      const duration = Date.now() - pressTime;
      if (duration < 300) {
        if (!wasMuted) setMuted(true);
      } else {
        if (wasMuted) setMuted(true);
      }
    };

    const onBlur = () => {
      if (spaceDown && wasMuted) {
        setMuted(true);
        spaceDown = false;
      }
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [setMuted]);
}

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

interface UseAutoScrollOpts {
  scrollRef: RefObject<HTMLElement | null>;
  active: boolean;
  speed?: number;
}

export function useAutoScroll({ scrollRef, active, speed = 40 }: UseAutoScrollOpts) {
  const [scrolling, setScrolling] = useState(false);
  const pausedRef = useRef(false);
  const rafRef = useRef(0);
  const lastTsRef = useRef(0);

  const onUserScroll = useCallback(() => {
    pausedRef.current = true;
    setScrolling(false);
  }, []);

  useEffect(() => {
    if (!active) {
      cancelAnimationFrame(rafRef.current);
      setScrolling(false);
      return;
    }

    pausedRef.current = false;
    lastTsRef.current = 0;

    const el = scrollRef.current;
    if (!el) return;

    const atBottom = (e: HTMLElement) =>
      e.scrollHeight - e.scrollTop - e.clientHeight < 2;

    const step = (ts: number) => {
      if (pausedRef.current) {
        setScrolling(false);
        return;
      }

      const e = scrollRef.current;
      if (!e) return;

      if (atBottom(e)) {
        setScrolling(false);
        return;
      }

      if (lastTsRef.current > 0) {
        const dt = (ts - lastTsRef.current) / 1000;
        e.scrollTop += speed * dt;
        setScrolling(true);
      }
      lastTsRef.current = ts;
      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);

    return () => {
      cancelAnimationFrame(rafRef.current);
    };
  }, [active, speed, scrollRef]);

  return { onUserScroll, scrolling };
}

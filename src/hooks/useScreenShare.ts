import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../lib/format-error';

export interface ScreenShareState {
  active: boolean;
  sourceId: string | null;
  sourceName: string | null;
  error: string | null;
}

const initial: ScreenShareState = {
  active: false,
  sourceId: null,
  sourceName: null,
  error: null,
};

export function useScreenShare() {
  const [state, setState] = useState<ScreenShareState>(initial);
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const stop = useCallback(() => {
    const s = streamRef.current;
    if (s) {
      s.getTracks().forEach((t) => t.stop());
    }
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setState(initial);
  }, []);

  const start = useCallback(async (sourceId: string, sourceName: string) => {
    try {
      const constraints: any = {
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId,
            maxWidth: 1920,
            maxHeight: 1200,
            maxFrameRate: 15,
          },
        },
      };
      const stream = await (navigator.mediaDevices as any).getUserMedia(constraints);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        const v = videoRef.current;
        v.play().catch(() => { /* ignore autoplay errors */ });
      }
      stream.getVideoTracks()[0]?.addEventListener('ended', () => stop());
      setState({ active: true, sourceId, sourceName, error: null });
    } catch (err: unknown) {
      setState({ ...initial, error: errorMessage(err) });
    }
  }, [stop]);

  const captureFrame = useCallback((): string | null => {
    const v = videoRef.current;
    if (!v || !streamRef.current) return null;
    const w = v.videoWidth;
    const h = v.videoHeight;
    if (!w || !h) return null;
    const maxW = 1280;
    const scale = w > maxW ? maxW / w : 1;
    const cw = Math.round(w * scale);
    const ch = Math.round(h * scale);
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, cw, ch);
    return canvas.toDataURL('image/jpeg', 0.82);
  }, []);

  useEffect(() => {
    return () => stop();
  }, [stop]);

  return { state, start, stop, captureFrame, videoRef };
}

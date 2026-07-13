import { ipcMain } from 'electron';
import { transcribePcm, isWhisperAvailable } from '../whisper.js';
import { polishAsrText } from '../asr-polish.js';
import { errorMessage } from '../format-error.js';

export function registerAsrIpc(): void {
  const MAX_PCM_BYTES = 5 * 60 * 16_000 * Float32Array.BYTES_PER_ELEMENT;
  const MAX_POLISH_CHARS = 20_000;
  let activeTranscriptions = 0;
  ipcMain.handle('asr:available', async () => {
    return { ok: true, available: isWhisperAvailable() };
  });

  ipcMain.handle('asr:transcribe', async (_e, pcmBuffer: ArrayBuffer, lang?: 'auto' | 'zh' | 'en') => {
    let acquired = false;
    try {
      if (activeTranscriptions >= 1) return { ok: false, error: 'another transcription is already running' };
      if (!(pcmBuffer instanceof ArrayBuffer)) return { ok: false, error: 'invalid PCM buffer' };
      if (pcmBuffer.byteLength === 0 || pcmBuffer.byteLength > MAX_PCM_BYTES) {
        return { ok: false, error: `PCM buffer must be between 1 and ${MAX_PCM_BYTES} bytes` };
      }
      if (pcmBuffer.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
        return { ok: false, error: 'PCM buffer must contain aligned Float32 samples' };
      }
      if (lang !== undefined && lang !== 'auto' && lang !== 'zh' && lang !== 'en') {
        return { ok: false, error: 'invalid ASR language' };
      }
      const samples = new Float32Array(pcmBuffer);
      activeTranscriptions += 1;
      acquired = true;
      const r = await Promise.race([
        transcribePcm(samples, lang ?? 'auto'),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('transcription timed out')), 120_000)),
      ]);
      return r;
    } catch (err: unknown) {
      return { ok: false, error: errorMessage(err) };
    } finally {
      if (acquired) activeTranscriptions -= 1;
    }
  });

  ipcMain.handle('asr:polish-text', async (_e, rawText: string) => {
    try {
      if (typeof rawText !== 'string') return { ok: false, error: 'text must be a string', text: '' };
      if (rawText.length > MAX_POLISH_CHARS) return { ok: false, error: 'text is too large', text: rawText.slice(0, MAX_POLISH_CHARS) };
      const polished = await polishAsrText(rawText);
      return { ok: true, text: polished };
    } catch (err: unknown) {
      return { ok: false, error: errorMessage(err), text: rawText };
    }
  });
}

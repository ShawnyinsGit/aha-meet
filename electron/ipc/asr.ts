import { ipcMain } from 'electron';
import { transcribePcm, isWhisperAvailable } from '../whisper.js';
import { errorMessage } from '../format-error.js';

export function registerAsrIpc(): void {
  ipcMain.handle('asr:available', async () => {
    return { ok: true, available: isWhisperAvailable() };
  });

  ipcMain.handle('asr:transcribe', async (_e, pcmBuffer: ArrayBuffer, lang?: 'auto' | 'zh' | 'en') => {
    try {
      const samples = new Float32Array(pcmBuffer);
      const r = await transcribePcm(samples, lang ?? 'auto');
      return r;
    } catch (err: unknown) {
      return { ok: false, error: errorMessage(err) };
    }
  });
}

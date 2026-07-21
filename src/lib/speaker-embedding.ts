// speaker-embedding.ts — lazy ONNX speaker embedding extractor (CAM++).
//
// Loads the 3D-Speaker CAM++ ONNX model in the renderer via onnxruntime-web,
// reusing the same wasm runtime that @ricky0123/vad-web already pulled into
// public/vad/. Exposes a single `embed(samples) → Float32Array` plus a cosine
// helper for the voice-lock gate in useVoiceCapture.
//
// Heavy: only initialized when something actually requests an embedding,
// not on app startup. ~28 MB model + ~20-50 MB wasm runtime, ~500 ms first
// hit, sub-100 ms per segment after warm-up.
//
// onnxruntime-web and fbank are dynamic-imported so they don't inflate the
// main bundle — the ~400 KB ORT JS bindings + fft.js only load when voice-lock
// is actually used.

import type { InferenceSession } from 'onnxruntime-web/wasm';
import { serializeOnnxSessionInitialization } from './onnx-session-init';

export const SPEAKER_MODEL_ID = '3dspeaker-campplus-v1';
const MODEL_URL = new URL('voice-id/3dspeaker_campplus_sv_zh_en_16k.onnx', document.baseURI).href;
const WASM_BASE = new URL('vad/', document.baseURI).href;

const MIN_FRAMES_FOR_EMBEDDING = 50; // 0.5s

let ortModule: typeof import('onnxruntime-web/wasm') | null = null;

async function getOrt(): Promise<typeof import('onnxruntime-web/wasm')> {
  if (!ortModule) ortModule = await import('onnxruntime-web/wasm');
  return ortModule;
}

let sessionPromise: Promise<InferenceSession> | null = null;

async function getSession(): Promise<InferenceSession> {
  if (sessionPromise) return sessionPromise;
  const ort = await getOrt();
  ort.env.wasm.wasmPaths = WASM_BASE;
  ort.env.wasm.numThreads = 1;
  sessionPromise = serializeOnnxSessionInitialization(() =>
    ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    }),
  );
  return sessionPromise;
}

export function prewarmSpeakerModel(): Promise<void> {
  return getSession().then(() => undefined).catch((e) => {
    sessionPromise = null;
    throw e;
  });
}

export async function releaseSpeakerModel(): Promise<void> {
  if (!sessionPromise) return;
  try {
    const session = await sessionPromise;
    await session.release();
  } catch { /* ignore */ }
  sessionPromise = null;
}

export async function embedSpeaker(samples: Float32Array): Promise<Float32Array | null> {
  const { computeFbank } = await import('./fbank');
  const { data: fbank, frames } = computeFbank(samples);
  if (frames < MIN_FRAMES_FOR_EMBEDDING) return null;

  const ort = await getOrt();
  const session = await getSession();
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  const tensor = new ort.Tensor('float32', fbank, [1, frames, 80]);
  const result = await session.run({ [inputName]: tensor });
  const raw = result[outputName].data as Float32Array;
  const emb = new Float32Array(raw.length);
  emb.set(raw);
  return l2Normalize(emb);
}

function l2Normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

export function averageEmbeddings(embeddings: Float32Array[]): Float32Array | null {
  if (embeddings.length === 0) return null;
  const dim = embeddings[0].length;
  const sum = new Float32Array(dim);
  for (const e of embeddings) {
    if (e.length !== dim) continue;
    for (let i = 0; i < dim; i++) sum[i] += e[i];
  }
  for (let i = 0; i < dim; i++) sum[i] /= embeddings.length;
  return l2Normalize(sum);
}

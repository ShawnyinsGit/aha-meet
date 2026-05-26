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

import * as ort from 'onnxruntime-web';
import { computeFbank } from './fbank';

export const SPEAKER_MODEL_ID = '3dspeaker-campplus-v1';
const MODEL_URL = new URL('voice-id/3dspeaker_campplus_sv_zh_en_16k.onnx', document.baseURI).href;
const WASM_BASE = new URL('vad/', document.baseURI).href;

// Below this many frames (10ms each) the embedding is unstable enough that
// we'd rather skip the gate than reject a legitimate short utterance.
const MIN_FRAMES_FOR_EMBEDDING = 50; // 0.5s

let sessionPromise: Promise<ort.InferenceSession> | null = null;

async function getSession(): Promise<ort.InferenceSession> {
  if (sessionPromise) return sessionPromise;
  // Reuse the wasm runtime files VAD already shipped, so we don't ship two
  // copies of the ORT wasm. Safe because both libraries pin
  // onnxruntime-web@^1.17 and the API surface we use is stable.
  ort.env.wasm.wasmPaths = WASM_BASE;
  // Threading off — Electron's renderer process isn't reliably cross-origin
  // isolated, so SharedArrayBuffer isn't available and ORT would crash with
  // numThreads > 1 anyway. Single-threaded CAM++ inference is ~50ms per
  // segment which is well within VAD's redemption window.
  ort.env.wasm.numThreads = 1;
  sessionPromise = ort.InferenceSession.create(MODEL_URL, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  return sessionPromise;
}

/**
 * Pre-warm the model so the first real embedding doesn't pay the
 * ~500 ms cold-start tax. Safe to call multiple times.
 */
export function prewarmSpeakerModel(): Promise<void> {
  return getSession().then(() => undefined).catch((e) => {
    // Don't poison the cache on transient errors — let the next caller retry.
    sessionPromise = null;
    throw e;
  });
}

/**
 * Extract a single speaker embedding from a Float32 PCM segment.
 *
 * @param samples 16 kHz mono Float32 PCM in [-1, 1].
 * @returns L2-normalized embedding (length 192 for CAM++), or null if the
 *          segment is too short for a reliable embedding.
 */
export async function embedSpeaker(samples: Float32Array): Promise<Float32Array | null> {
  const { data: fbank, frames } = computeFbank(samples);
  if (frames < MIN_FRAMES_FOR_EMBEDDING) return null;

  const session = await getSession();
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  // CAM++ expects [batch=1, T, 80].
  const tensor = new ort.Tensor('float32', fbank, [1, frames, 80]);
  const result = await session.run({ [inputName]: tensor });
  const raw = result[outputName].data as Float32Array;
  // Copy out so the result's backing buffer can be GC'd; also detach from ORT.
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

/**
 * Cosine similarity between two L2-normalized embedding vectors. With
 * unit-length inputs this is just a dot product, but we keep the explicit
 * form so the function is correct for non-normalized inputs too.
 */
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

/**
 * Average multiple per-segment embeddings into one enrollment vector.
 * Re-normalizes after averaging so the result is unit-length and directly
 * comparable to single-segment embeddings via dot product.
 */
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

// fbank.ts — Kaldi-style 80-dim log-mel filterbank feature extractor.
//
// Matches the input contract for 3D-Speaker CAM++:
//   - 16 kHz mono Float32 PCM in [-1, 1]
//   - 25 ms window (400 samples), 10 ms hop (160 samples)
//   - 512-point FFT, power spectrum
//   - 80 HTK-mel filters from 0 to 8000 Hz
//   - log(max(energy, 1e-10))
//   - per-utterance mean subtraction (CMN), no variance normalization
//
// The HTK mel scale + Hamming window + post-CMN combination matches the
// preprocessing used during CAM++ training; getting any one of these wrong
// makes embeddings useless (high similarity across speakers). Keep these
// constants pinned — do not "modernize" them.

import FFT from 'fft.js';

const SAMPLE_RATE = 16000;
const WIN_LEN = 400;   // 25ms
const HOP_LEN = 160;   // 10ms
const N_FFT = 512;
const N_MELS = 80;
const F_MIN = 0;
const F_MAX = SAMPLE_RATE / 2;
const EPSILON = 1e-10;

let cached: {
  window: Float32Array;
  melFilters: Float32Array[]; // [N_MELS] each of length N_FFT/2+1
  fft: FFT;
  fftIn: Float64Array;
  fftOut: Float64Array;
} | null = null;

function hamming(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // Kaldi uses 0.54 - 0.46 cos — match exactly.
    w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
  }
  return w;
}

function hzToMel(hz: number): number {
  // HTK mel scale (what Kaldi uses by default).
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1);
}

function buildMelFilters(): Float32Array[] {
  const nBins = N_FFT / 2 + 1; // 257
  const melMin = hzToMel(F_MIN);
  const melMax = hzToMel(F_MAX);
  // N_MELS + 2 mel points → N_MELS triangular filters
  const melPoints = new Float64Array(N_MELS + 2);
  for (let i = 0; i < melPoints.length; i++) {
    melPoints[i] = melMin + ((melMax - melMin) * i) / (N_MELS + 1);
  }
  const hzPoints = melPoints.map(melToHz);
  // Map Hz → FFT bin index (real-valued).
  const binPoints = new Float64Array(hzPoints.length);
  for (let i = 0; i < hzPoints.length; i++) {
    binPoints[i] = (hzPoints[i] * N_FFT) / SAMPLE_RATE;
  }
  const filters: Float32Array[] = [];
  for (let m = 1; m <= N_MELS; m++) {
    const left = binPoints[m - 1];
    const center = binPoints[m];
    const right = binPoints[m + 1];
    const filt = new Float32Array(nBins);
    for (let k = 0; k < nBins; k++) {
      if (k < left || k > right) continue;
      if (k <= center) {
        filt[k] = (k - left) / Math.max(center - left, 1e-12);
      } else {
        filt[k] = (right - k) / Math.max(right - center, 1e-12);
      }
    }
    filters.push(filt);
  }
  return filters;
}

function ensureCached() {
  if (cached) return cached;
  const fft = new FFT(N_FFT);
  cached = {
    window: hamming(WIN_LEN),
    melFilters: buildMelFilters(),
    fft,
    fftIn: new Float64Array(N_FFT),
    fftOut: new Float64Array(N_FFT * 2),
  };
  return cached;
}

/**
 * Compute log-mel fbank features for one utterance.
 *
 * @param samples 16 kHz mono Float32 PCM in [-1, 1].
 * @returns Flat Float32Array of shape [T, 80] in row-major order, where
 *          T = floor((samples - WIN_LEN) / HOP_LEN) + 1. Caller is expected
 *          to reshape via `[T, 80]` strides; we keep it flat so the ONNX
 *          runtime can consume it as a Tensor without extra copies.
 *          Also returns the frame count so the caller doesn't have to
 *          recompute it.
 */
export function computeFbank(samples: Float32Array): { data: Float32Array; frames: number } {
  const { window, melFilters, fft, fftIn, fftOut } = ensureCached();

  if (samples.length < WIN_LEN) {
    // Too short for even one frame — return empty.
    return { data: new Float32Array(0), frames: 0 };
  }

  const numFrames = Math.floor((samples.length - WIN_LEN) / HOP_LEN) + 1;
  const out = new Float32Array(numFrames * N_MELS);
  const nBins = N_FFT / 2 + 1;
  // Running sums for per-bin mean (CMN). Compute after the loop.
  const meanAcc = new Float64Array(N_MELS);

  for (let f = 0; f < numFrames; f++) {
    const start = f * HOP_LEN;
    // Zero-pad the FFT input buffer past the window length.
    for (let i = 0; i < WIN_LEN; i++) {
      fftIn[i] = samples[start + i] * window[i];
    }
    for (let i = WIN_LEN; i < N_FFT; i++) fftIn[i] = 0;

    // realTransform writes packed real-input output; we then build the power
    // spectrum for the first nBins bins ourselves.
    fft.realTransform(fftOut, fftIn);
    // fft.js realTransform packs: out[0]=DC, out[1]=0, out[2k]=Re, out[2k+1]=Im
    // up to bin N/2; bins above N/2 are the conjugate mirror and are not filled.
    // We need power = re^2 + im^2 for bins 0..N/2.
    const power = new Float64Array(nBins);
    power[0] = fftOut[0] * fftOut[0];
    for (let k = 1; k < nBins - 1; k++) {
      const re = fftOut[2 * k];
      const im = fftOut[2 * k + 1];
      power[k] = re * re + im * im;
    }
    // Nyquist bin: stored as real-only at index 1 by fft.js? In radix-4 packed
    // layout, the N/2 bin's real component lives at out[N] with imag 0. Guard
    // by computing from out[N] if present, else fall back to standard layout.
    {
      const k = nBins - 1;
      const re = fftOut[2 * k] ?? 0;
      const im = fftOut[2 * k + 1] ?? 0;
      power[k] = re * re + im * im;
    }

    // Mel projection + log.
    for (let m = 0; m < N_MELS; m++) {
      const filt = melFilters[m];
      let energy = 0;
      for (let k = 0; k < nBins; k++) energy += filt[k] * power[k];
      const logE = Math.log(Math.max(energy, EPSILON));
      out[f * N_MELS + m] = logE;
      meanAcc[m] += logE;
    }
  }

  // CMN: subtract per-bin mean across all frames in this utterance.
  for (let m = 0; m < N_MELS; m++) meanAcc[m] /= numFrames;
  for (let f = 0; f < numFrames; f++) {
    for (let m = 0; m < N_MELS; m++) {
      out[f * N_MELS + m] -= meanAcc[m];
    }
  }

  return { data: out, frames: numFrames };
}

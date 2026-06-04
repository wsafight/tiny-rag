import { invariant } from './invariant';

/**
 * Compute the dot product of two equal-length vectors.
 * If both vectors are L2-normalized, the dot product equals cosine similarity.
 */
export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  invariant(a.length !== b.length, `dot: vector length mismatch, a=${a.length}, b=${b.length}`);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * L2-normalize a vector (a zero vector is returned unchanged).
 */
export function normalize(vec: readonly number[]): number[] {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec.slice();
  const out = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

/**
 * The query hot path uses Float32Array to avoid mixing plain arrays in later dot products.
 */
export function normalizeToFloat32(vec: readonly number[]): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const out = new Float32Array(vec.length);
  const norm = Math.sqrt(sum);
  if (norm === 0) {
    out.set(vec);
    return out;
  }
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

/**
 * Check whether a value is a valid non-empty numeric array (used to validate embeddings).
 */
export function hasValidEmbedding(v: unknown, expectedDim?: number): v is number[] {
  if (!Array.isArray(v) || v.length === 0) return false;
  if (expectedDim !== undefined && v.length !== expectedDim) return false;
  for (const n of v) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return false;
  }
  return true;
}

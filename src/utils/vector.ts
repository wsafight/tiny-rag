import { invariant } from './invariant';

/**
 * 计算两个等长向量的点积。
 * 若两个向量都已 L2 归一化，则点积等于 cosine 相似度。
 */
export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  invariant(a.length !== b.length, `dot: 向量长度不一致，a=${a.length}, b=${b.length}`);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * 对向量做 L2 归一化（零向量保持原样返回）。
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
 * 查询热路径使用 Float32Array，避免后续向量点积时混用普通数组。
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
 * 判断一个值是否为合法的非空数值数组（用于校验 embedding）。
 */
export function hasValidEmbedding(v: unknown, expectedDim?: number): v is number[] {
  if (!Array.isArray(v) || v.length === 0) return false;
  if (expectedDim !== undefined && v.length !== expectedDim) return false;
  for (const n of v) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return false;
  }
  return true;
}

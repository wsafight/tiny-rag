import { createHash, type Hash } from 'node:crypto';

export type { Hash };

export function sha1Hex(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

export function createSha1(): Hash {
  return createHash('sha1');
}

export function updateHashWithJson(hash: Hash, value: unknown): void {
  hash.update(JSON.stringify(value));
  hash.update('\n');
}

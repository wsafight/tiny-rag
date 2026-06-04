import { invariant } from './invariant';
import { hasValidEmbedding } from './vector';

export function assertArray(value: unknown, message: string): asserts value is unknown[] {
  invariant(!Array.isArray(value), message);
}

export function assertPositiveInteger(name: string, value: number): void {
  invariant(!Number.isInteger(value) || value < 1, `${name} 必须是 >= 1 的整数，收到 ${value}`);
}

export function assertNonNegativeInteger(name: string, value: number): void {
  invariant(!Number.isInteger(value) || value < 0, `${name} 必须是 >= 0 的整数，收到 ${value}`);
}

export function assertNonNegativeNumber(name: string, value: number): void {
  invariant(!Number.isFinite(value) || value < 0, `${name} 必须是 >= 0 的数字，收到 ${value}`);
}

export function assertNumberInRange(
  name: string,
  value: number,
  min: number,
  max: number,
): void {
  invariant(
    !Number.isFinite(value) || value < min || value > max,
    `${name} 必须在 [${min}, ${max}] 内，收到 ${value}`,
  );
}

export function assertLessThan(
  name: string,
  value: number,
  upperName: string,
  upperValue: number,
): void {
  invariant(value >= upperValue, `${name} 必须小于 ${upperName}，当前 ${value} >= ${upperValue}`);
}

export function assertValidEmbedding(
  value: unknown,
  message: string,
  expectedDim?: number,
): asserts value is number[] {
  invariant(!hasValidEmbedding(value, expectedDim), message);
}

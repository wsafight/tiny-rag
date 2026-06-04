import { invariant } from './invariant';
import { hasValidEmbedding } from './vector';

export function assertArray(value: unknown, message: string): asserts value is unknown[] {
  invariant(!Array.isArray(value), message);
}

export function assertPositiveInteger(name: string, value: number): void {
  invariant(!Number.isInteger(value) || value < 1, `${name} must be an integer >= 1, received ${value}`);
}

export function assertNonNegativeInteger(name: string, value: number): void {
  invariant(!Number.isInteger(value) || value < 0, `${name} must be an integer >= 0, received ${value}`);
}

export function assertNonNegativeNumber(name: string, value: number): void {
  invariant(!Number.isFinite(value) || value < 0, `${name} must be a number >= 0, received ${value}`);
}

export function assertNumberInRange(
  name: string,
  value: number,
  min: number,
  max: number,
): void {
  invariant(
    !Number.isFinite(value) || value < min || value > max,
    `${name} must be within [${min}, ${max}], received ${value}`,
  );
}

export function assertLessThan(
  name: string,
  value: number,
  upperName: string,
  upperValue: number,
): void {
  invariant(value >= upperValue, `${name} must be less than ${upperName}, currently ${value} >= ${upperValue}`);
}

export function assertValidEmbedding(
  value: unknown,
  message: string,
  expectedDim?: number,
): asserts value is number[] {
  invariant(!hasValidEmbedding(value, expectedDim), message);
}

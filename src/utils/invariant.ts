export function invariant(condition: true, errorMsg: string): never;
export function invariant(
  condition: boolean,
  errorMsg: string,
): asserts condition is false;
export function invariant(
  condition: boolean,
  errorMsg: string,
): asserts condition is false {
  if (condition) {
    fail(errorMsg);
  }
}

export function fail(errorMsg: string): never {
  throw new Error(errorMsg);
}

export default invariant;

import { fail, invariant } from '../src/utils/invariant';

export type EnvSource = Record<string, string | undefined>;

export interface EnvNumberOptions {
  min?: number;
  max?: number;
}

export function envString(env: EnvSource, key: string, fallback = ''): string {
  const value = env[key];
  return value === undefined || value === '' ? fallback : value;
}

export function envChoice<T extends string>(
  env: EnvSource,
  key: string,
  choices: readonly T[],
  fallback: T,
): T {
  const value = envString(env, key, fallback).toLowerCase();
  invariant(
    !(choices as readonly string[]).includes(value),
    `${key} 必须是 ${choices.join(' | ')} 之一，收到 ${value}`,
  );
  return value as T;
}

export function envNumber(
  env: EnvSource,
  key: string,
  fallback: number,
  opts: EnvNumberOptions = {},
): number {
  const raw = envString(env, key, String(fallback));
  const value = Number(raw);
  invariant(!Number.isFinite(value), `${key} 必须是数字，收到 ${raw}`);
  invariant(opts.min !== undefined && value < opts.min, `${key} 必须 >= ${opts.min}，收到 ${raw}`);
  invariant(opts.max !== undefined && value > opts.max, `${key} 必须 <= ${opts.max}，收到 ${raw}`);
  return value;
}

export function envInteger(
  env: EnvSource,
  key: string,
  fallback: number,
  opts: EnvNumberOptions = {},
): number {
  const value = envNumber(env, key, fallback, opts);
  invariant(
    !Number.isInteger(value),
    `${key} 必须是整数，收到 ${envString(env, key, String(fallback))}`,
  );
  return value;
}

export function envBoolean(env: EnvSource, key: string, fallback: boolean): boolean {
  const raw = envString(env, key, fallback ? '1' : '0').toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(raw)) return true;
  if (['0', 'false', 'off', 'no'].includes(raw)) return false;
  return fail(`${key} 必须是 1/0、true/false、on/off 或 yes/no，收到 ${raw}`);
}

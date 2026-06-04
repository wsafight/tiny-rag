import {
  assertNonNegativeInteger,
  assertNumberInRange,
  assertPositiveInteger,
} from '../utils/validation';

export interface ProviderRuntimeOptions {
  requestTimeoutMs?: number;
  requestRetries?: number;
  ollamaEmbedConcurrency?: number;
  llmTemperature?: number;
}

export interface ResolvedProviderRuntimeOptions {
  requestTimeoutMs: number;
  requestRetries: number;
  ollamaEmbedConcurrency: number;
  llmTemperature: number;
}

export const DEFAULT_PROVIDER_RUNTIME_OPTIONS: ResolvedProviderRuntimeOptions = {
  requestTimeoutMs: 60_000,
  requestRetries: 2,
  ollamaEmbedConcurrency: 4,
  llmTemperature: 0.2,
};

export function resolveProviderRuntimeOptions(
  options: ProviderRuntimeOptions = {},
): ResolvedProviderRuntimeOptions {
  const resolved = {
    ...DEFAULT_PROVIDER_RUNTIME_OPTIONS,
    ...options,
  };

  assertPositiveInteger('requestTimeoutMs', resolved.requestTimeoutMs);
  assertNonNegativeInteger('requestRetries', resolved.requestRetries);
  assertPositiveInteger('ollamaEmbedConcurrency', resolved.ollamaEmbedConcurrency);
  assertNumberInRange('llmTemperature', resolved.llmTemperature, 0, 2);

  return resolved;
}

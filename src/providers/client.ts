import { embedOpenAICompatible, chatOpenAICompatible } from './openai-compatible';
import { embedOllama, chatOllama } from './ollama';
import { invariant } from '../utils/index';
import { assertArray, assertValidEmbedding } from '../utils/validation';
import { resolveProviderRuntimeOptions } from './runtime';
import type {
  ChatFunction,
  ChatMessage,
  ChatOptions,
  EmbedFunction,
  EmbeddingConfig,
  LLMConfig,
} from './types';
import type { ProviderRuntimeOptions } from './runtime';

export type { ProviderRuntimeOptions, ResolvedProviderRuntimeOptions } from './runtime';
export { DEFAULT_PROVIDER_RUNTIME_OPTIONS, resolveProviderRuntimeOptions } from './runtime';

function validateEmbeddings(vectors: unknown, expectedCount: number, label: string): number[][] {
  assertArray(vectors, `${label} return value is not an array of vectors`);
  invariant(
    vectors.length !== expectedCount,
    `${label} count mismatch: ${expectedCount} inputs sent, ${vectors.length} returned`,
  );
  if (expectedCount === 0) return [];

  const first = vectors[0];
  assertValidEmbedding(first, `${label} embedding #1 is invalid`);
  const dim = first.length;

  const validated: number[][] = [];
  for (let i = 0; i < vectors.length; i++) {
    const vector = vectors[i];
    assertValidEmbedding(vector, `${label} embedding #${i + 1} is invalid or has an inconsistent dim`, dim);
    validated.push(vector);
  }
  return validated;
}

export async function embed(
  inputs: readonly string[],
  config: EmbeddingConfig,
  options: ProviderRuntimeOptions = {},
): Promise<number[][]> {
  const resolved = resolveProviderRuntimeOptions(options);
  const vectors =
    config.provider === 'ollama'
      ? await embedOllama(config, inputs, resolved)
      : await embedOpenAICompatible(config, inputs, resolved);
  return validateEmbeddings(vectors, inputs.length, `${config.provider}/${config.model} embedding`);
}

export function createEmbedder(
  config: EmbeddingConfig,
  options: ProviderRuntimeOptions = {},
): EmbedFunction {
  return (inputs) => embed(inputs, config, options);
}

export async function chat(
  messages: readonly ChatMessage[],
  config: LLMConfig,
  opts: ChatOptions = {},
  options: ProviderRuntimeOptions = {},
): Promise<string> {
  const resolved = resolveProviderRuntimeOptions(options);
  if (config.provider === 'ollama') {
    return chatOllama(config, messages, opts, resolved);
  }
  return chatOpenAICompatible(config, messages, opts, resolved);
}

export function createChat(
  config: LLMConfig,
  options: ProviderRuntimeOptions = {},
): ChatFunction {
  return (messages, opts) => chat(messages, config, opts, options);
}

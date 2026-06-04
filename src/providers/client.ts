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
  assertArray(vectors, `${label} 返回值不是向量数组`);
  invariant(
    vectors.length !== expectedCount,
    `${label} 返回数量不匹配：输入 ${expectedCount} 条，返回 ${vectors.length} 条`,
  );
  if (expectedCount === 0) return [];

  const first = vectors[0];
  assertValidEmbedding(first, `${label} 返回的第 1 条 embedding 非法`);
  const dim = first.length;

  const validated: number[][] = [];
  for (let i = 0; i < vectors.length; i++) {
    const vector = vectors[i];
    assertValidEmbedding(vector, `${label} 返回的第 ${i + 1} 条 embedding 非法或维度不一致`, dim);
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
